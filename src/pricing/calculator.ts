import { isDealActive, isDealExpired, resolveDealKind } from "../domain/deal.js";
import type { ModelPricing, RateKind, RateTier } from "../domain/model.js";
import type { CostBreakdown } from "../domain/route.js";

/**
 * §14 rate-kind classifier. Maps a model's priceBasis + (optional, currently-active) deal
 * onto the six-value rate taxonomy. A deal that is expired or not yet started (§14
 * startsAt gate) is treated as absent — its classification falls through to priceBasis
 * alone. Anything that cannot be confidently classified resolves to UNKNOWN_RATE.
 */
export function classifyRateKind(model: ModelPricing, now: Date = new Date()): RateKind {
  const deal = model.deal;
  if (deal && isDealActive(deal, now)) {
    const kind = resolveDealKind(deal);
    switch (kind) {
      case "free":
        return "FREE_RATE";
      case "temporary_rate":
        return "TEMPORARY_RATE";
      case "permanent_rate":
      case "fixed_rate":
        return "PERMANENT_RATE";
      case "multiplier":
        if (
          typeof deal.multiplier !== "number" ||
          !Number.isFinite(deal.multiplier) ||
          deal.multiplier <= 0
        ) {
          // A multiplier deal without a usable multiplier is unclassifiable.
          return "UNKNOWN_RATE";
        }
        // A multiplier only ever scales a genuinely pre-discount rate; anything else
        // (post_discount, temporary_introductory_rate, ...) is not a fresh base to
        // multiply — the double-discount guard in resolveEffectiveRates relies on this.
        return model.priceBasis === "current_rate" ? "PRE_DISCOUNT_RATE" : "POST_DISCOUNT_RATE";
      default:
        return "UNKNOWN_RATE";
    }
  }

  switch (model.priceBasis) {
    case "post_discount":
      return "POST_DISCOUNT_RATE";
    case "current_rate":
      return "PRE_DISCOUNT_RATE";
    case "temporary_introductory_rate":
      return "TEMPORARY_RATE";
    default:
      return "UNKNOWN_RATE";
  }
}

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
  /** §14 rate-kind classification computed for this request (see classifyRateKind). */
  rateKind: RateKind;
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

  // §14: an unclassifiable rate must not be silently priced at some default — it makes
  // the model ineligible for pricing/routing entirely.
  const rateKind = classifyRateKind(model, now);
  if (rateKind === "UNKNOWN_RATE") {
    throw new Error(
      `Model ${model.id} has an unclassifiable rate (UNKNOWN_RATE per §14 taxonomy) and is ineligible for pricing`,
    );
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

  // §14/§34.2: multiplier deals scale a rate at pricing time (unlike free/fixed/permanent
  // deals, whose effective numbers are already baked into the model's rate fields). A
  // multiplier is only ever applied to a genuinely pre-discount rate; classifyRateKind
  // already encodes that gate (a multiplier deal on a non-current_rate model classifies
  // as POST_DISCOUNT_RATE, not PRE_DISCOUNT_RATE), so this check is a real, load-bearing
  // guard against double-discounting, not decorative.
  if (model.deal && isDealActive(model.deal, now) && resolveDealKind(model.deal) === "multiplier") {
    if (rateKind === "PRE_DISCOUNT_RATE") {
      const factor = 1 / (model.deal.multiplier as number);
      input *= factor;
      output *= factor;
      cacheRead *= factor;
      cacheWrite *= factor;
      priceBasis = "post_discount";
    }
    // else: CRITICAL — refuse to apply the multiplier. The rate is already
    // post-discount/temporary/permanent; multiplying it again would double-discount.
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

  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: cacheRead,
    cacheWritePerMillion: cacheWrite,
    priceBasis,
    dealApplied,
    tierLabel,
    rateKind,
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
