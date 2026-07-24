import type { RoutingConfig } from "../config/schemas.js";
import { isDealExpired } from "../domain/deal.js";
import { type ModelPricing, type QualityTier, TIER_RANK } from "../domain/model.js";
import type { RejectionReason } from "../domain/route.js";
import type { ClassifiedTask } from "../domain/task.js";

export interface EligibilityInput {
  models: ModelPricing[];
  liveModelIds: Set<string> | null;
  config: RoutingConfig;
  task: ClassifiedTask;
  qualityFloor: QualityTier;
  noFree: boolean;
  now?: Date;
  explicitModel?: string;
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

  if (input.explicitModel) {
    const model = input.models.find((m) => m.id === input.explicitModel);
    if (!model) {
      rejected.push({
        modelId: input.explicitModel,
        reason: "explicit model not present in pricing snapshot",
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
