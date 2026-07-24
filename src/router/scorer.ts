import type { RoutingConfig } from "../config/schemas.js";
import type { ModelPricing, QualityTier } from "../domain/model.js";
import { TIER_RANK } from "../domain/model.js";
import type { CandidateScore } from "../domain/route.js";
import type { ClassifiedTask, RoutingProfile } from "../domain/task.js";
import type { ModelTelemetry } from "../domain/telemetry.js";
import { type TokenEstimate, calculateRequestCost } from "../pricing/calculator.js";

function successRate(t?: ModelTelemetry): number {
  if (!t || t.attempts === 0) return 0.85; // neutral prior
  return t.successfulRuns / t.attempts;
}

function failureRate(t?: ModelTelemetry, minObs = 5): number {
  if (!t || t.attempts < minObs) return 0.1;
  return Math.min(0.9, t.failedRuns / t.attempts);
}

export function scoreCandidates(options: {
  models: ModelPricing[];
  task: ClassifiedTask;
  config: RoutingConfig;
  profile: RoutingProfile;
  telemetry: Map<string, ModelTelemetry>;
  preferred: string[];
  now?: Date;
}): CandidateScore[] {
  const weights = options.config.profiles[options.profile];
  const taskPolicy = options.config.task_classes[options.task.taskClass];
  if (!taskPolicy) {
    throw new Error(`Missing task class policy for ${options.task.taskClass}`);
  }
  const priors = taskPolicy.token_priors;
  const tokens: TokenEstimate = {
    freshInput: Math.max(priors.freshInput, Math.ceil(options.task.cleanedText.length / 4)),
    cachedInput: priors.cachedInput,
    output: priors.output,
    cacheWrite: priors.cacheWrite,
  };
  const minObs = options.config.telemetry.minObservationsForPenalty;

  const scored: CandidateScore[] = [];
  for (const model of options.models) {
    const tel = options.telemetry.get(model.id);
    const fail = failureRate(tel, minObs);
    const baseCost = calculateRequestCost(model, tokens, { now: options.now });
    const expectedRetryCost =
      baseCost.estimatedRequestCost * fail * options.config.reliability.retryCostFactor;
    const expectedEscalationCost =
      baseCost.estimatedRequestCost * fail * options.config.reliability.escalationCostFactor;
    const avgLat = tel?.averageLatencyMs ?? 15_000;
    const latencyPenalty = (avgLat / 1000) * options.config.reliability.latencyPenaltyPerSecondUsd;
    const cost = calculateRequestCost(model, tokens, {
      now: options.now,
      expectedRetryCost,
      expectedEscalationCost,
      latencyPenalty,
    });

    const sr = successRate(tel);
    const tier = model.qualityTier;
    const qualityScore = TIER_RANK[tier as QualityTier] / 3;
    // Lower score is better (cost-like). Convert multi-objective into a single cost-like score.
    const score =
      weights.costWeight * cost.expectedTotalCost +
      weights.reliabilityWeight * (1 - sr) * Math.max(cost.estimatedRequestCost, 0.001) +
      weights.latencyWeight * latencyPenalty +
      weights.qualityWeight * (1 - qualityScore) * Math.max(cost.estimatedRequestCost, 0.01);

    scored.push({
      modelId: model.id,
      qualityTier: tier,
      cost,
      successRate: sr,
      averageLatencyMs: avgLat,
      score,
      preferred: options.preferred.includes(model.id),
    });
  }
  return scored;
}
