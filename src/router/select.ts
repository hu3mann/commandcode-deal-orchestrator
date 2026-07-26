import type { RoutingConfig } from "../config/schemas.js";
import type { ModelPricing } from "../domain/model.js";
import type { CandidateScore, RouteDecision } from "../domain/route.js";
import type { ClassifiedTask, RoutingProfile } from "../domain/task.js";
import type { ModelTelemetry } from "../domain/telemetry.js";
import { snapshotAgeMs } from "../pricing/snapshot.js";
import { type LiveCatalogStatus, filterEligible, resolveQualityFloor } from "./eligibility.js";
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
  /** See router/eligibility.ts#LiveCatalogStatus. Optional; when omitted, behaves exactly
   * as before this field existed (CCROUTE-001 defect 2). */
  liveCatalogStatus?: LiveCatalogStatus;
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

function nearlyEqual(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) < epsilon;
}

/**
 * §21 tie-break: a genuine 5-step total order, applied throughout candidate sorting (not
 * bolted on afterward for only the top two candidates, and not skipped for any profile —
 * CCROUTE-001 defect 4). Steps, in priority order:
 *   1. lower adjusted expected cost
 *   2. higher smoothed success rate (router/scorer.ts#smoothedSuccessRate)
 *   3. lower average latency
 *   4. configured preference order (task_classes[...].preferred; lower list index wins,
 *      unlisted models rank after every listed one)
 *   5. lexical exact model id (guarantees a total order even if every field above ties)
 *
 * `preferred` is closed over rather than stored on CandidateScore so the comparator can
 * rank by *position* in the configured list, not just list membership.
 */
export function makeTieBreak(
  preferred: string[],
  epsilon: number,
): (a: CandidateScore, b: CandidateScore) => number {
  const preferenceRank = (id: string): number => {
    const idx = preferred.indexOf(id);
    return idx === -1 ? Number.POSITIVE_INFINITY : idx;
  };
  return (a: CandidateScore, b: CandidateScore): number => {
    // 1: lower adjusted expected cost
    if (!nearlyEqual(a.cost.expectedTotalCost, b.cost.expectedTotalCost, epsilon)) {
      return a.cost.expectedTotalCost - b.cost.expectedTotalCost;
    }
    // 2: higher smoothed success rate
    if (!nearlyEqual(a.successRate, b.successRate, epsilon)) {
      return b.successRate - a.successRate;
    }
    // 3: lower average latency
    if (!nearlyEqual(a.averageLatencyMs, b.averageLatencyMs, epsilon)) {
      return a.averageLatencyMs - b.averageLatencyMs;
    }
    // 4: configured preference order
    const ra = preferenceRank(a.modelId);
    const rb = preferenceRank(b.modelId);
    if (ra !== rb) return ra - rb;
    // 5: lexical exact model id
    return a.modelId.localeCompare(b.modelId);
  };
}

export function selectRoute(input: SelectInput): RouteDecision {
  const profile = input.profile ?? input.task.overrides.profile ?? input.config.defaultProfile;

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
    liveCatalogStatus: input.liveCatalogStatus,
    config: input.config,
    task: input.task,
    qualityFloor,
    noFree,
    now: input.now,
    explicitModel,
    pricingRetrievedAt: input.pricingRetrievedAt,
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

  const epsilon = input.config.scoring.floatEpsilon;
  const tieBreak = makeTieBreak(preferred, epsilon);

  // Profile-specific primary ordering; the full 5-step tieBreak (including preference
  // order and lexical id) resolves every remaining tie for every profile — no profile is
  // exempted (CCROUTE-001 defect 4: `frontier` used to skip the preferred-boost entirely).
  if (profile === "frontier") {
    candidates.sort((a, b) => {
      const rank = (t: string) => (t === "frontier" ? 3 : t === "capable" ? 2 : 1);
      if (rank(a.qualityTier) !== rank(b.qualityTier)) {
        return rank(b.qualityTier) - rank(a.qualityTier);
      }
      return tieBreak(a, b);
    });
  } else if (profile === "cheapest") {
    candidates.sort((a, b) => {
      if (!nearlyEqual(a.cost.expectedTotalCost, b.cost.expectedTotalCost, epsilon)) {
        return a.cost.expectedTotalCost - b.cost.expectedTotalCost;
      }
      return tieBreak(a, b);
    });
  } else {
    candidates.sort((a, b) => {
      if (!nearlyEqual(a.score, b.score, epsilon)) return a.score - b.score;
      return tieBreak(a, b);
    });
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
    "tieBreak=cost>smoothedSuccessRate>latency>preferenceOrder>lexical",
  ].join("; ");

  return {
    schemaVersion: 1,
    taskClass: input.task.taskClass,
    profile,
    selectedModelId: selected.modelId,
    qualityFloor,
    candidates,
    rejected,
    tieBreakRule:
      "lower expectedTotalCost, higher smoothed successRate, lower averageLatencyMs, " +
      "configured preference order, lexical modelId",
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
