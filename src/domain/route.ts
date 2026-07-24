import { z } from "zod";
import { QualityTierSchema } from "./model.js";
import { RoutingProfileSchema, TaskClassSchema } from "./task.js";

export const RejectionReasonSchema = z.object({
  modelId: z.string(),
  reason: z.string(),
});
export type RejectionReason = z.infer<typeof RejectionReasonSchema>;

export const CostBreakdownSchema = z.object({
  freshInputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  cacheWriteTokens: z.number(),
  freshInputCost: z.number(),
  cachedInputCost: z.number(),
  outputCost: z.number(),
  cacheWriteCost: z.number(),
  estimatedRequestCost: z.number(),
  expectedRetryCost: z.number(),
  expectedEscalationCost: z.number(),
  latencyPenalty: z.number(),
  expectedTotalCost: z.number(),
  priceBasis: z.string(),
  dealApplied: z.boolean(),
  estimateLabel: z.literal("estimate"),
});
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

export const CandidateScoreSchema = z.object({
  modelId: z.string(),
  qualityTier: QualityTierSchema,
  cost: CostBreakdownSchema,
  successRate: z.number(),
  averageLatencyMs: z.number(),
  score: z.number(),
  preferred: z.boolean(),
});
export type CandidateScore = z.infer<typeof CandidateScoreSchema>;

export const RouteDecisionSchema = z.object({
  schemaVersion: z.literal(1),
  taskClass: TaskClassSchema,
  profile: RoutingProfileSchema,
  selectedModelId: z.string(),
  qualityFloor: QualityTierSchema,
  candidates: z.array(CandidateScoreSchema),
  rejected: z.array(RejectionReasonSchema),
  tieBreakRule: z.string(),
  dealAffectedSelection: z.boolean(),
  pricingSnapshotAgeMs: z.number(),
  pricingSnapshotRetrievedAt: z.string(),
  overridesApplied: z.array(z.string()),
  fallbackFrom: z.string().optional(),
  fallbackReason: z.string().optional(),
  explanation: z.string(),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
