import { isDealExpired } from "../domain/deal.js";
import type { ModelPricing, RateTier } from "../domain/model.js";
import type { CostBreakdown } from "../domain/route.js";

export interface TokenEstimate {
  freshInput: number;
  cachedInput: number;
  output: number;
  cacheWrite: number;
  estimatedContext?: number;
}

export interface EffectiveRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
  priceBasis: string;
  dealApplied: boolean;
  tierLabel?: string;
}

function pickTier(model: ModelPricing, contextTokens: number): RateTier | undefined {
  if (!model.tiers?.length) return undefined;
  const sorted = [...model.tiers].sort((a, b) => a.maxContext - b.maxContext);
  for (const t of sorted) {
    if (contextTokens <= t.maxContext) return t;
  }
  return sorted[sorted.length - 1];
}

export function resolveEffectiveRates(
  model: ModelPricing,
  tokenEstimate: TokenEstimate,
  now = new Date(),
): EffectiveRates {
  if (model.availability === "expired_deal") {
    throw new Error(`Model ${model.id} has an expired deal and cannot be priced for routing`);
  }

  if (model.deal && isDealExpired(model.deal.expiresAt, now)) {
    throw new Error(`Deal for ${model.id} expired at ${model.deal.expiresAt}`);
  }

  let input = model.inputPerMillion ?? 0;
  let output = model.outputPerMillion ?? 0;
  let cacheRead = model.cacheReadPerMillion ?? 0;
  let cacheWrite = model.cacheWritePerMillion ?? 0;
  let tierLabel: string | undefined;
  let priceBasis: string = model.priceBasis;
  const dealApplied = Boolean(model.deal);

  const contextTokens =
    tokenEstimate.estimatedContext ??
    tokenEstimate.freshInput + tokenEstimate.cachedInput + tokenEstimate.output;

  const tier = pickTier(model, contextTokens);
  if (tier) {
    input = tier.inputPerMillion;
    output = tier.outputPerMillion;
    cacheRead = tier.cacheReadPerMillion;
    cacheWrite = tier.cacheWritePerMillion ?? 0;
    tierLabel = `max_context<=${tier.maxContext}`;
  }

  // Temporary intro rate rollover
  if (model.rateExpiresAt && model.replacementRate) {
    const exp = new Date(model.rateExpiresAt);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) {
      input = model.replacementRate.inputPerMillion;
      output = model.replacementRate.outputPerMillion;
      cacheRead = model.replacementRate.cacheReadPerMillion;
      cacheWrite = model.replacementRate.cacheWritePerMillion ?? 0;
      priceBasis = "replacement_rate";
    }
  }

  // CRITICAL: never apply promotional multipliers when already post_discount
  // Rates are used as-is.

  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: cacheRead,
    cacheWritePerMillion: cacheWrite,
    priceBasis,
    dealApplied,
    tierLabel,
  };
}

function perMillion(tokens: number, rate: number): number {
  return (tokens / 1_000_000) * rate;
}

export function calculateRequestCost(
  model: ModelPricing,
  tokens: TokenEstimate,
  opts?: {
    now?: Date;
    expectedRetryCost?: number;
    expectedEscalationCost?: number;
    latencyPenalty?: number;
  },
): CostBreakdown {
  const rates = resolveEffectiveRates(model, tokens, opts?.now);
  const freshInputCost = perMillion(tokens.freshInput, rates.inputPerMillion);
  const cachedInputCost = perMillion(tokens.cachedInput, rates.cacheReadPerMillion);
  const outputCost = perMillion(tokens.output, rates.outputPerMillion);
  const cacheWriteCost = perMillion(tokens.cacheWrite, rates.cacheWritePerMillion);
  const estimatedRequestCost = freshInputCost + cachedInputCost + outputCost + cacheWriteCost;
  const expectedRetryCost = opts?.expectedRetryCost ?? 0;
  const expectedEscalationCost = opts?.expectedEscalationCost ?? 0;
  const latencyPenalty = opts?.latencyPenalty ?? 0;

  return {
    freshInputTokens: tokens.freshInput,
    cachedInputTokens: tokens.cachedInput,
    outputTokens: tokens.output,
    cacheWriteTokens: tokens.cacheWrite,
    freshInputCost,
    cachedInputCost,
    outputCost,
    cacheWriteCost,
    estimatedRequestCost,
    expectedRetryCost,
    expectedEscalationCost,
    latencyPenalty,
    expectedTotalCost:
      estimatedRequestCost + expectedRetryCost + expectedEscalationCost + latencyPenalty,
    priceBasis: rates.priceBasis,
    dealApplied: rates.dealApplied,
    estimateLabel: "estimate",
  };
}
