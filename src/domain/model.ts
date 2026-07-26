import { z } from "zod";

export const QualityTierSchema = z.enum(["economical", "capable", "frontier"]);
export type QualityTier = z.infer<typeof QualityTierSchema>;

export const PriceBasisSchema = z.enum([
  "post_discount",
  "current_rate",
  "temporary_introductory_rate",
]);
export type PriceBasis = z.infer<typeof PriceBasisSchema>;

export const AvailabilitySchema = z.enum(["available", "expired_deal", "unavailable"]);
export type Availability = z.infer<typeof AvailabilitySchema>;

/**
 * §14 rate taxonomy. Every priced model resolves to exactly one of these; a rate that
 * cannot be confidently classified resolves to UNKNOWN_RATE rather than silently pricing
 * at some default (see pricing/calculator.ts#classifyRateKind).
 */
export const RateKindSchema = z.enum([
  "PRE_DISCOUNT_RATE",
  "POST_DISCOUNT_RATE",
  "FREE_RATE",
  "TEMPORARY_RATE",
  "PERMANENT_RATE",
  "UNKNOWN_RATE",
]);
export type RateKind = z.infer<typeof RateKindSchema>;

/**
 * §14 deal-kind taxonomy. `multiplier` deals (e.g. "4x usage") scale a genuinely
 * pre-discount rate at pricing time; `fixed_rate`/`permanent_rate`/`temporary_rate`/`free`
 * deals describe rates that are already baked into the model's rate fields.
 */
export const DealKindSchema = z.enum([
  "free",
  "multiplier",
  "fixed_rate",
  "temporary_rate",
  "permanent_rate",
]);
export type DealKind = z.infer<typeof DealKindSchema>;

export const DealSchema = z.object({
  /** Legacy 3-value classification, kept for back-compat with existing seed files and
   * consumers (router/eligibility, cli) that pattern-match on it directly. */
  type: z.enum(["permanent_price_reduction", "free", "temporary_rate"]),
  /** §14 taxonomy. Optional for back-compat; derive via resolveDealKind() when absent. */
  kind: DealKindSchema.optional(),
  label: z.string(),
  expiresAt: z.string().nullable().optional(),
  /** §14: instant the deal takes effect. A deal is not applied before this instant. */
  startsAt: z.string().nullable().optional(),
  /** Required (and validated) when kind === "multiplier"; e.g. 4 for a "4x usage" deal. */
  multiplier: z.number().positive().optional(),
  capacityLimited: z.boolean().optional(),
});
export type Deal = z.infer<typeof DealSchema>;

export const RateTierSchema = z.object({
  maxContext: z.number().positive(),
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cacheReadPerMillion: z.number().nonnegative().default(0),
  cacheWritePerMillion: z.number().nonnegative().optional(),
});
export type RateTier = z.infer<typeof RateTierSchema>;

export const ReplacementRateSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cacheReadPerMillion: z.number().nonnegative().default(0),
  cacheWritePerMillion: z.number().nonnegative().optional(),
});

export const ModelPricingSchema = z.object({
  id: z.string().min(1),
  contextWindow: z.number().positive(),
  inputPerMillion: z.number().nonnegative().optional(),
  outputPerMillion: z.number().nonnegative().optional(),
  cacheReadPerMillion: z.number().nonnegative().optional(),
  cacheWritePerMillion: z.number().nonnegative().optional(),
  tiers: z.array(RateTierSchema).optional(),
  priceBasis: PriceBasisSchema,
  qualityTier: QualityTierSchema,
  // §13/§17: declared model capabilities, checked as a hard eligibility gate
  // against ClassifiedTask.requiredCapabilities. Optional and absent-means-unknown:
  // a model that declares nothing is not rejected, because rejecting on absence
  // would exclude every model until every catalog entry is annotated.
  capabilities: z.array(z.string()).optional(),
  availability: AvailabilitySchema.default("available"),
  deal: DealSchema.optional(),
  rateExpiresAt: z.string().optional(),
  replacementRate: ReplacementRateSchema.optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const PricingSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  retrievedAt: z.string(),
  source: z.string(),
  sourceHash: z.string(),
  models: z.array(ModelPricingSchema),
});
export type PricingSnapshot = z.infer<typeof PricingSnapshotSchema>;

export const TIER_RANK: Record<QualityTier, number> = {
  economical: 1,
  capable: 2,
  frontier: 3,
};
