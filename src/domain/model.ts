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

export const DealSchema = z.object({
  type: z.enum(["permanent_price_reduction", "free", "temporary_rate"]),
  label: z.string(),
  expiresAt: z.string().nullable().optional(),
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
