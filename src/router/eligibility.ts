import type { RoutingConfig } from "../config/schemas.js";
import { isDealExpired } from "../domain/deal.js";
import { type ModelPricing, type QualityTier, TIER_RANK } from "../domain/model.js";
import type { RejectionReason } from "../domain/route.js";
import type { ClassifiedTask } from "../domain/task.js";
import { evaluatePricingUsability } from "../pricing/snapshot.js";
import { estimateContextTokens, estimateRequestTokens } from "./token-estimate.js";

/**
 * Distinguishes "the live model catalog is genuinely unreachable/unverifiable" from "no
 * live-catalog check was requested at all" (CCROUTE-001 defect 2). `liveModelIds: null`
 * alone is ambiguous between those two cases — a caller offline by design (no `cmd`
 * configured) and a caller whose live fetch failed both produce `liveModelIds: null`
 * today, and treating them the same silently fails OPEN (every static seed model gets
 * treated as live-verified) exactly when §2.3/§13 require failing CLOSED instead.
 *
 * - `undefined` (the default): legacy/unspecified — behaves exactly as before this fix,
 *   i.e. `liveModelIds` (Set or null) is trusted as-is. This keeps every existing caller
 *   that doesn't know about this field compiling and behaving identically.
 * - `"available"`: the catalog was fetched successfully; `liveModelIds` should be the real
 *   Set of live ids and is enforced as before.
 * - `"unavailable"`: the catalog fetch was attempted and failed (or returned nothing
 *   usable). Every model is rejected rather than silently trusted, because the live
 *   inventory is the authoritative source (§13) and we have no way to confirm any static
 *   seed model is actually still live.
 */
export type LiveCatalogStatus = "available" | "unavailable";

/**
 * §17 required-capabilities gate. `ModelPricing` (owned by src/domain/model.ts, outside
 * this remediation's file ownership — see final report) does not yet declare a
 * `capabilities` field, so real seed/pricing-snapshot data can never carry one until that
 * schema is extended. This structural type lets in-memory `ModelPricing` objects that DO
 * carry a `capabilities` array (e.g. a future data source, or tests) be gated correctly
 * without needing a schema change in this file.
 */
export type ModelWithCapabilities = ModelPricing & { capabilities?: string[] };

function modelCapabilities(model: ModelPricing): string[] | undefined {
  return (model as ModelWithCapabilities).capabilities;
}

export interface EligibilityInput {
  models: ModelPricing[];
  liveModelIds: Set<string> | null;
  liveCatalogStatus?: LiveCatalogStatus;
  config: RoutingConfig;
  task: ClassifiedTask;
  qualityFloor: QualityTier;
  noFree: boolean;
  now?: Date;
  explicitModel?: string;
  /** Pricing snapshot's `retrievedAt` (§15 staleness gate, CCROUTE-001 defect 6). Optional
   * so existing direct callers of filterEligible that predate this field keep compiling
   * and skip the staleness gate entirely (matching their previous behavior); selectRoute
   * always threads its `pricingRetrievedAt` through here. */
  pricingRetrievedAt?: string;
}

export interface EligibilityResult {
  eligible: ModelPricing[];
  rejected: RejectionReason[];
}

function modelTier(model: ModelPricing, config: RoutingConfig): QualityTier {
  for (const tier of ["frontier", "capable", "economical"] as const) {
    if (config.quality_tiers[tier].includes(model.id)) return tier;
  }
  return model.qualityTier;
}

export function filterEligible(input: EligibilityInput): EligibilityResult {
  const now = input.now ?? new Date();
  const rejected: RejectionReason[] = [];
  const eligible: ModelPricing[] = [];

  // §17 estimated-context gate: reuse the existing token estimator (no second estimator),
  // computed once since it does not vary per-candidate.
  const tokens = estimateRequestTokens(input.task, input.config);
  const estimatedContext = estimateContextTokens(tokens);
  const requiredCapabilities = input.task.requiredCapabilities;

  /** Hard technical gates (§17 context/capabilities, §15 staleness) that apply to a
   * candidate regardless of whether it was reached explicitly or via the general pool —
   * unlike policy gates (quality floor, high_risk_review-vs-economical), a model that
   * literally cannot fit the estimated context or lacks a declared required capability
   * cannot serve the request no matter how it was selected. Returns a rejection reason, or
   * undefined if the model clears every hard gate. */
  function checkHardGates(model: ModelPricing): string | undefined {
    if (estimatedContext > model.contextWindow) {
      return (
        `estimated context ${estimatedContext} tokens exceeds model context window ` +
        `${model.contextWindow} tokens`
      );
    }

    if (requiredCapabilities.length > 0) {
      const caps = modelCapabilities(model);
      // Absent capability metadata is treated as UNKNOWN, not "lacks the capability": today
      // no ModelPricing in the real pricing snapshot declares `capabilities` at all (see
      // ModelWithCapabilities doc comment), so punishing absence would silently reject
      // every model and break routing entirely. Only a model that explicitly declares a
      // capabilities list AND omits a required one is rejected.
      if (caps) {
        const missing = requiredCapabilities.filter((c) => !caps.includes(c));
        if (missing.length > 0) {
          return `missing required capabilities: ${missing.join(", ")}`;
        }
      }
    }

    if (input.pricingRetrievedAt) {
      const usability = evaluatePricingUsability({
        model,
        retrievedAt: input.pricingRetrievedAt,
        now,
        thresholds: {
          freshMaxAgeMs: input.config.pricing.freshMaxAgeMs,
          acceptableMaxAgeMs: input.config.pricing.acceptableMaxAgeMs,
        },
      });
      if (!usability.usable) return usability.reason;
    }

    return undefined;
  }

  if (input.explicitModel) {
    const model = input.models.find((m) => m.id === input.explicitModel);
    if (!model) {
      rejected.push({
        modelId: input.explicitModel,
        reason: "explicit model not present in pricing snapshot",
      });
      return { eligible: [], rejected };
    }
    if (input.liveCatalogStatus === "unavailable") {
      rejected.push({
        modelId: model.id,
        reason:
          "live model catalog unavailable; cannot verify explicit model against the " +
          "authoritative live catalog (failing closed per live-inventory-authoritative policy)",
      });
      return { eligible: [], rejected };
    }
    if (input.liveModelIds && !input.liveModelIds.has(model.id)) {
      rejected.push({
        modelId: model.id,
        reason: "explicit model not in live CommandCode catalog",
      });
      return { eligible: [], rejected };
    }
    if (model.availability === "expired_deal" || isDealExpired(model.deal?.expiresAt, now)) {
      rejected.push({ modelId: model.id, reason: "explicit model deal expired" });
      return { eligible: [], rejected };
    }
    if (
      model.priceBasis === "temporary_introductory_rate" &&
      model.rateExpiresAt &&
      new Date(model.rateExpiresAt).getTime() <= now.getTime() &&
      !model.replacementRate
    ) {
      rejected.push({
        modelId: model.id,
        reason: "temporary rate expired without replacement rate",
      });
      return { eligible: [], rejected };
    }
    const hardReason = checkHardGates(model);
    if (hardReason) {
      rejected.push({ modelId: model.id, reason: hardReason });
      return { eligible: [], rejected };
    }
    return { eligible: [model], rejected };
  }

  for (const model of input.models) {
    if (model.availability === "unavailable") {
      rejected.push({ modelId: model.id, reason: "marked unavailable" });
      continue;
    }
    if (model.availability === "expired_deal") {
      rejected.push({ modelId: model.id, reason: "expired deal" });
      continue;
    }
    if (model.deal && isDealExpired(model.deal.expiresAt, now)) {
      rejected.push({ modelId: model.id, reason: `deal expired at ${model.deal.expiresAt}` });
      continue;
    }
    if (
      model.priceBasis === "temporary_introductory_rate" &&
      model.rateExpiresAt &&
      new Date(model.rateExpiresAt).getTime() <= now.getTime() &&
      !model.replacementRate
    ) {
      rejected.push({
        modelId: model.id,
        reason: "temporary rate expired without replacement",
      });
      continue;
    }
    if (input.liveCatalogStatus === "unavailable") {
      rejected.push({
        modelId: model.id,
        reason:
          "live model catalog unavailable; refusing to treat static seed model as " +
          "live-verified (failing closed per live-inventory-authoritative policy)",
      });
      continue;
    }
    if (input.liveModelIds && !input.liveModelIds.has(model.id)) {
      rejected.push({ modelId: model.id, reason: "not in live model catalog" });
      continue;
    }
    if (input.noFree && model.deal?.type === "free") {
      rejected.push({ modelId: model.id, reason: "free models excluded (--no-free)" });
      continue;
    }
    // Never route high_risk_review to economical unless explicit override (handled above)
    const tier = modelTier(model, input.config);
    if (TIER_RANK[tier] < TIER_RANK[input.qualityFloor]) {
      rejected.push({
        modelId: model.id,
        reason: `below quality floor ${input.qualityFloor} (tier=${tier})`,
      });
      continue;
    }
    if (
      input.task.taskClass === "high_risk_review" &&
      tier === "economical" &&
      !input.explicitModel
    ) {
      rejected.push({
        modelId: model.id,
        reason: "high_risk_review cannot use economical tier without explicit override",
      });
      continue;
    }
    const hardReason = checkHardGates(model);
    if (hardReason) {
      rejected.push({ modelId: model.id, reason: hardReason });
      continue;
    }
    eligible.push(model);
  }

  return { eligible, rejected };
}

export function resolveQualityFloor(
  config: RoutingConfig,
  taskClass: ClassifiedTask["taskClass"],
): QualityTier {
  return config.task_classes[taskClass]?.minimum_tier ?? "capable";
}
