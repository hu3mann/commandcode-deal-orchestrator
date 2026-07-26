import type { RoutingConfig, ScoringConfig } from "../config/schemas.js";
import type { ModelPricing, QualityTier } from "../domain/model.js";
import { TIER_RANK } from "../domain/model.js";
import type { CandidateScore } from "../domain/route.js";
import type { ClassifiedTask, RoutingProfile } from "../domain/task.js";
import type { ModelTelemetry } from "../domain/telemetry.js";
import { calculateRequestCost } from "../pricing/calculator.js";
import { estimateRequestTokens } from "./token-estimate.js";

/**
 * §20/§21 smoothed success rate (CCROUTE-001 defect 3). Bayesian/Laplace smoothing with a
 * configurable neutral prior: a model with zero attempts gets exactly `priorMean` (the
 * documented neutral prior), and a model with a handful of real attempts is pulled toward
 * `priorMean` in proportion to `priorWeight` "virtual" prior observations — so e.g. one
 * real failure out of one real attempt does NOT zero the rate the way a raw
 * successfulRuns/attempts ratio would. As `attempts` grows past `priorWeight`, the smoothed
 * value converges toward the true observed rate. This is the single success-rate value
 * used both for scoring (below) and for tie-break step 2 (§21, see router/select.ts).
 */
export function smoothedSuccessRate(
  t: ModelTelemetry | undefined,
  smoothing: ScoringConfig["successRateSmoothing"],
): number {
  const attempts = t?.attempts ?? 0;
  const successes = t?.successfulRuns ?? 0;
  const priorSuccessWeight = smoothing.priorMean * smoothing.priorWeight;
  return (successes + priorSuccessWeight) / (attempts + smoothing.priorWeight);
}

function failureRate(
  t: ModelTelemetry | undefined,
  minObs: number,
  scoring: ScoringConfig,
): number {
  if (!t || t.attempts < minObs) return scoring.defaultFailureRate;
  return Math.min(scoring.maxFailureRate, t.failedRuns / t.attempts);
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
  const scoring = options.config.scoring;
  // Single source of truth for estimated tokens — shared with router/eligibility.ts's
  // context-window gate (CCROUTE-001 defect 1: do not invent a second estimator).
  const tokens = estimateRequestTokens(options.task, options.config);
  const minObs = options.config.telemetry.minObservationsForPenalty;

  const scored: CandidateScore[] = [];
  for (const model of options.models) {
    const tel = options.telemetry.get(model.id);
    const fail = failureRate(tel, minObs, scoring);
    const baseCost = calculateRequestCost(model, tokens, { now: options.now });
    const expectedRetryCost =
      baseCost.estimatedRequestCost * fail * options.config.reliability.retryCostFactor;
    const expectedEscalationCost =
      baseCost.estimatedRequestCost * fail * options.config.reliability.escalationCostFactor;
    const avgLat = tel?.averageLatencyMs ?? scoring.defaultAverageLatencyMs;
    const latencyPenalty = (avgLat / 1000) * options.config.reliability.latencyPenaltyPerSecondUsd;
    const cost = calculateRequestCost(model, tokens, {
      now: options.now,
      expectedRetryCost,
      expectedEscalationCost,
      latencyPenalty,
    });

    const sr = smoothedSuccessRate(tel, scoring.successRateSmoothing);
    const tier = model.qualityTier;
    const qualityScore = TIER_RANK[tier as QualityTier] / scoring.qualityTierDivisor;
    // Lower score is better (cost-like). Convert multi-objective into a single cost-like score.
    const score =
      weights.costWeight * cost.expectedTotalCost +
      weights.reliabilityWeight *
        (1 - sr) *
        Math.max(cost.estimatedRequestCost, scoring.reliabilityCostFloorUsd) +
      weights.latencyWeight * latencyPenalty +
      weights.qualityWeight *
        (1 - qualityScore) *
        Math.max(cost.estimatedRequestCost, scoring.qualityCostFloorUsd);

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
