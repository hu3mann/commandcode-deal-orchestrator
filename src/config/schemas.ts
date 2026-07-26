import { z } from "zod";
import { QualityTierSchema } from "../domain/model.js";
import { RoutingProfileSchema, TaskClassSchema } from "../domain/task.js";

export const ProfileWeightsSchema = z.object({
  costWeight: z.number().nonnegative(),
  reliabilityWeight: z.number().nonnegative(),
  latencyWeight: z.number().nonnegative(),
  qualityWeight: z.number().nonnegative(),
});

export const TokenPriorsSchema = z.object({
  freshInput: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative().default(0),
});

export const TaskClassPolicySchema = z.object({
  minimum_tier: QualityTierSchema,
  preferred: z.array(z.string()).default([]),
  token_priors: TokenPriorsSchema,
});

export const RoutingConfigSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.object({
    cheapest: ProfileWeightsSchema,
    balanced: ProfileWeightsSchema,
    frontier: ProfileWeightsSchema,
  }),
  quality_tiers: z.object({
    economical: z.array(z.string()),
    capable: z.array(z.string()),
    frontier: z.array(z.string()),
  }),
  task_classes: z.record(TaskClassSchema, TaskClassPolicySchema),
  orchestration: z.object({
    maxPlannerRevisions: z.number().int().nonnegative().default(1),
    maxRepairs: z.number().int().nonnegative().default(1),
    maxFormatRepairs: z.number().int().nonnegative().default(1),
    plannerMaxTurns: z.number().int().positive().default(4),
    advisorMaxTurns: z.number().int().positive().default(4),
    executorMaxTurns: z.number().int().positive().default(20),
    reviewerMaxTurns: z.number().int().positive().default(5),
    minClassForOrchestration: TaskClassSchema.default("standard_build"),
  }),
  security: z.object({
    rejectUnknownSecurityKeys: z.boolean().default(true),
    allowUnsafeYoloDefault: z.boolean().default(false),
    maxPromptBytes: z.number().int().positive().default(500_000),
    maxResultBytes: z.number().int().positive().default(2_000_000),
    defaultTimeoutMs: z.number().int().positive().default(600_000),
  }),
  telemetry: z.object({
    enabled: z.boolean().default(true),
    path: z.string(),
    minObservationsForPenalty: z.number().int().nonnegative().default(5),
  }),
  reliability: z.object({
    retryCostFactor: z.number().nonnegative().default(0.35),
    escalationCostFactor: z.number().nonnegative().default(0.5),
    latencyPenaltyPerSecondUsd: z.number().nonnegative().default(0.00001),
  }),
  defaultProfile: RoutingProfileSchema.default("balanced"),
  cmdPath: z.string().optional(),
  noFree: z.boolean().default(false),
});
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

/** Keys that must not appear as unknown top-level or nested security overrides */
export const SECURITY_SENSITIVE_KEYS = new Set([
  "allowUnsafeYoloDefault",
  "unsafeYolo",
  "yolo",
  "dangerouslySkipPermissions",
  "autoAcceptDefault",
  "shell",
  "apiKey",
  "token",
  "credentials",
]);

/**
 * Keys that may only be supplied from user-scope config (~/.commandcode/deal-router.yaml)
 * or explicit CLI overrides, and must be rejected when they appear in project-scope config
 * (<cwd>/.commandcode/deal-router.yaml). A project directory is untrusted input: anyone who
 * can get a repo checked out (or a file dropped into it) can otherwise steer these values.
 *
 * `cmdPath` is the canonical example: it names an executable that ccroute will spawn, so
 * letting project-scope config set it is equivalent to arbitrary code execution on any
 * ccroute invocation run from that directory (including read-only, no-LLM commands like
 * `ccroute decide`). See src/config/merge.ts for the enforcement point.
 */
export const PROJECT_FORBIDDEN_KEYS = new Set(["cmdPath"]);
