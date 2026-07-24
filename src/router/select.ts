import type { RoutingConfig } from "../config/schemas.js";
import type { ModelPricing } from "../domain/model.js";
import type { CandidateScore, RouteDecision } from "../domain/route.js";
import type { ClassifiedTask, RoutingProfile } from "../domain/task.js";
import type { ModelTelemetry } from "../domain/telemetry.js";
import { snapshotAgeMs } from "../pricing/snapshot.js";
import { filterEligible, resolveQualityFloor } from "./eligibility.js";
import { scoreCandidates } from "./scorer.js";

export class RouteError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RouteError";
    this.code = code;
  }
}

export interface SelectInput {
  models: ModelPricing[];
  liveModelIds: Set<string> | null;
  config: RoutingConfig;
  task: ClassifiedTask;
  profile?: RoutingProfile;
  telemetry?: Map<string, ModelTelemetry>;
  pricingRetrievedAt: string;
  now?: Date;
  maxEstimatedCost?: number;
  noFree?: boolean;
  cliModel?: string;
}

function tieBreak(a: CandidateScore, b: CandidateScore): number {
  // 1 lower adjusted expected cost
  if (a.cost.expectedTotalCost !== b.cost.expectedTotalCost) {
    return a.cost.expectedTotalCost - b.cost.expectedTotalCost;
  }
  // 2 higher success rate
  if (a.successRate !== b.successRate) return b.successRate - a.successRate;
  // 3 lower latency
  if (a.averageLatencyMs !== b.averageLatencyMs) {
    return a.averageLatencyMs - b.averageLatencyMs;
  }
  // 4 lexical model id
  return a.modelId.localeCompare(b.modelId);
}

export function selectRoute(input: SelectInput): RouteDecision {
  const profile = input.cliModel
    ? (input.profile ?? input.task.overrides.profile ?? input.config.defaultProfile)
    : (input.profile ?? input.task.overrides.profile ?? input.config.defaultProfile);

  const explicitModel = input.cliModel ?? input.task.overrides.model;
  const noFree = Boolean(input.noFree ?? input.task.overrides.noFree ?? input.config.noFree);
  const qualityFloor = resolveQualityFloor(input.config, input.task.taskClass);
  const maxCost = input.maxEstimatedCost ?? input.task.overrides.maxEstimatedCost;

  const overridesApplied: string[] = [];
  if (input.cliModel) overridesApplied.push(`cli-model=${input.cliModel}`);
  else if (input.task.overrides.model) {
    overridesApplied.push(`marker-model=${input.task.overrides.model}`);
  }
  if (input.profile) overridesApplied.push(`cli-profile=${input.profile}`);
  else if (input.task.overrides.profile) {
    overridesApplied.push(`marker-profile=${input.task.overrides.profile}`);
  }
  if (noFree) overridesApplied.push("no-free");
  if (maxCost !== undefined) overridesApplied.push(`max-estimated-cost=${maxCost}`);

  const { eligible, rejected } = filterEligible({
    models: input.models,
    liveModelIds: input.liveModelIds,
    config: input.config,
    task: input.task,
    qualityFloor,
    noFree,
    now: input.now,
    explicitModel,
  });

  if (eligible.length === 0) {
    if (explicitModel) {
      throw new RouteError(
        "EXPLICIT_MODEL_UNAVAILABLE",
        `Required model unavailable: ${explicitModel}. ${rejected.map((r) => r.reason).join("; ")}`,
      );
    }
    throw new RouteError(
      "NO_ELIGIBLE_MODEL",
      `No model satisfies quality floor ${qualityFloor}. Rejected: ${rejected.map((r) => `${r.modelId}:${r.reason}`).join(", ")}`,
    );
  }

  const preferred = input.config.task_classes[input.task.taskClass]?.preferred ?? [];
  const telemetry = input.telemetry ?? new Map();

  let candidates = scoreCandidates({
    models: eligible,
    task: input.task,
    config: input.config,
    profile,
    telemetry,
    preferred,
    now: input.now,
  });

  if (maxCost !== undefined) {
    const over = candidates.filter((c) => c.cost.expectedTotalCost > maxCost);
    for (const c of over) {
      rejected.push({
        modelId: c.modelId,
        reason: `expected cost ${c.cost.expectedTotalCost.toFixed(6)} exceeds max ${maxCost}`,
      });
    }
    candidates = candidates.filter((c) => c.cost.expectedTotalCost <= maxCost);
    if (candidates.length === 0) {
      throw new RouteError(
        "MAX_COST_EXCEEDED",
        `All candidates exceed max estimated cost ${maxCost}`,
      );
    }
  }

  // Profile-specific ordering
  if (profile === "frontier") {
    candidates.sort((a, b) => {
      const tr = b.qualityTier.localeCompare(a.qualityTier); // frontier > capable lexically wrong
      const rank = (t: string) => (t === "frontier" ? 3 : t === "capable" ? 2 : 1);
      if (rank(a.qualityTier) !== rank(b.qualityTier)) {
        return rank(b.qualityTier) - rank(a.qualityTier);
      }
      return tieBreak(a, b);
    });
  } else if (profile === "cheapest") {
    candidates.sort((a, b) => {
      if (a.cost.expectedTotalCost !== b.cost.expectedTotalCost) {
        return a.cost.expectedTotalCost - b.cost.expectedTotalCost;
      }
      return tieBreak(a, b);
    });
  } else {
    candidates.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return tieBreak(a, b);
    });
  }

  // Mild preferred boost: if top two nearly equal cost, prefer listed preferred
  if (candidates.length >= 2 && profile !== "frontier") {
    const top = candidates[0]!;
    const second = candidates[1]!;
    if (
      second.preferred &&
      !top.preferred &&
      Math.abs(top.cost.expectedTotalCost - second.cost.expectedTotalCost) < 1e-9
    ) {
      candidates = [second, top, ...candidates.slice(2)];
    }
  }

  const selected = candidates[0]!;
  const dealAffected = candidates.some((c) => c.cost.dealApplied && c.modelId === selected.modelId);

  const explanation = [
    `taskClass=${input.task.taskClass}`,
    `risk=${input.task.riskLevel}`,
    `profile=${profile}`,
    `floor=${qualityFloor}`,
    `selected=${selected.modelId}`,
    `expectedTotalCost=${selected.cost.expectedTotalCost.toFixed(6)} (estimate)`,
    `priceBasis=${selected.cost.priceBasis}`,
    `dealApplied=${selected.cost.dealApplied}`,
    "tieBreak=cost>success>latency>lexical",
  ].join("; ");

  return {
    schemaVersion: 1,
    taskClass: input.task.taskClass,
    profile,
    selectedModelId: selected.modelId,
    qualityFloor,
    candidates,
    rejected,
    tieBreakRule: "lower expectedTotalCost, higher successRate, lower latency, lexical modelId",
    dealAffectedSelection: dealAffected,
    pricingSnapshotAgeMs: snapshotAgeMs(
      input.pricingRetrievedAt,
      (input.now ?? new Date()).getTime(),
    ),
    pricingSnapshotRetrievedAt: input.pricingRetrievedAt,
    overridesApplied,
    explanation,
  };
}
