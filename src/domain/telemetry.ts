import { z } from "zod";
import { TaskClassSchema } from "./task.js";

export const ModelTelemetrySchema = z.object({
  modelId: z.string(),
  attempts: z.number().int().nonnegative().default(0),
  successfulRuns: z.number().int().nonnegative().default(0),
  failedRuns: z.number().int().nonnegative().default(0),
  timeouts: z.number().int().nonnegative().default(0),
  toolFailures: z.number().int().nonnegative().default(0),
  schemaFailures: z.number().int().nonnegative().default(0),
  repairTurns: z.number().int().nonnegative().default(0),
  testPassRate: z.number().min(0).max(1).default(1),
  averageLatencyMs: z.number().nonnegative().default(0),
  estimatedCost: z.number().nonnegative().default(0),
  observedCost: z.number().nonnegative().optional(),
  operatorOverrides: z.number().int().nonnegative().default(0),
});
export type ModelTelemetry = z.infer<typeof ModelTelemetrySchema>;

export const TelemetryEventSchema = z.object({
  schemaVersion: z.literal(1),
  ts: z.string(),
  runId: z.string(),
  event: z.string(),
  modelId: z.string().optional(),
  taskClass: TaskClassSchema.optional(),
  success: z.boolean().optional(),
  latencyMs: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
  observedCostUsd: z.number().optional(),
  errorCode: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;
