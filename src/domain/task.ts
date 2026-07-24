import { z } from "zod";

export const TaskClassSchema = z.enum([
  "read_only",
  "trivial_edit",
  "standard_build",
  "complex_build",
  "architecture",
  "high_risk_review",
]);
export type TaskClass = z.infer<typeof TaskClassSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RoutingProfileSchema = z.enum(["cheapest", "balanced", "frontier"]);
export type RoutingProfile = z.infer<typeof RoutingProfileSchema>;

export const TaskOverrideSchema = z.object({
  profile: RoutingProfileSchema.optional(),
  model: z.string().optional(),
  noFree: z.boolean().optional(),
  maxEstimatedCost: z.number().positive().optional(),
});
export type TaskOverride = z.infer<typeof TaskOverrideSchema>;

export const ClassifiedTaskSchema = z.object({
  originalText: z.string(),
  cleanedText: z.string(),
  taskClass: TaskClassSchema,
  riskLevel: RiskLevelSchema,
  signals: z.array(z.string()),
  overrides: TaskOverrideSchema,
  requiredCapabilities: z.array(z.string()),
});
export type ClassifiedTask = z.infer<typeof ClassifiedTaskSchema>;
