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

/**
 * §20/§21 success-rate smoothing. Bayesian/Laplace smoothing with a configurable neutral
 * prior: `priorMean` is what a model with zero observed attempts is assumed to have, and
 * `priorWeight` is how many "virtual" prior observations that neutral prior is worth. A
 * real attempt count below `priorWeight` is pulled toward `priorMean` rather than swinging
 * to the raw ratio, so e.g. one real failure out of one real attempt does not zero the
 * smoothed rate (CCROUTE-001 defect 3). See router/scorer.ts#smoothedSuccessRate.
 */
export const SuccessRateSmoothingSchema = z.object({
  priorMean: z.number().min(0).max(1).default(0.85),
  priorWeight: z.number().positive().default(5),
});
export type SuccessRateSmoothing = z.infer<typeof SuccessRateSmoothingSchema>;

/**
 * §20: every scoring coefficient must live in configuration, be documented, and be
 * surfaced by `ccroute explain` (see router/explain.ts) rather than buried as opaque
 * literals in router/scorer.ts / router/select.ts (CCROUTE-001 defect 5).
 */
export const ScoringConfigSchema = z.object({
  successRateSmoothing: SuccessRateSmoothingSchema.default({}),
  /** failureRate fallback for a model below telemetry.minObservationsForPenalty attempts. */
  defaultFailureRate: z.number().min(0).max(1).default(0.1),
  /** Hard cap applied to the observed failure rate so one catastrophic model can't blow up
   * the cost-like score. */
  maxFailureRate: z.number().min(0).max(1).default(0.9),
  /** Assumed average latency (ms) for a model with no telemetry observations yet. */
  defaultAverageLatencyMs: z.number().positive().default(15_000),
  /** Divisor turning TIER_RANK (1..3) into a 0..1 quality score. Equal to the number of
   * quality tiers (economical/capable/frontier) today; kept configurable so adding a tier
   * later doesn't require a code change. */
  qualityTierDivisor: z.number().positive().default(3),
  /** Cost floor (USD) the reliability-weight penalty is scaled against, so a near-zero
   * estimatedRequestCost doesn't make the reliability term vanish. */
  reliabilityCostFloorUsd: z.number().nonnegative().default(0.001),
  /** Cost floor (USD) the quality-weight penalty is scaled against. Kept independently
   * configurable from reliabilityCostFloorUsd — the two literals were historically
   * different arbitrary values (CCROUTE-001 defect 5) and are left at their original
   * defaults here (rather than silently unified) since changing either changes relative
   * candidate ordering; operators can now equalize them via config if desired. */
  qualityCostFloorUsd: z.number().nonnegative().default(0.01),
  /** Absolute-difference epsilon below which two candidates' tie-break fields (cost USD,
   * success-rate ratio, latency ms) are treated as equal, guarding against float noise from
   * chained arithmetic rather than comparing for exact equality. */
  floatEpsilon: z.number().nonnegative().default(1e-9),
});
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/**
 * §15 staleness thresholds, mirroring pricing/snapshot.ts#DEFAULT_FRESHNESS_THRESHOLDS
 * (duplicated as plain numeric defaults here, rather than imported, to avoid a
 * config/schemas.ts -> pricing/snapshot.ts import edge). Configurable so operators can
 * tighten/loosen the staleness gate wired into router/eligibility.ts (CCROUTE-001 defect 6).
 */
export const PricingFreshnessConfigSchema = z.object({
  freshMaxAgeMs: z
    .number()
    .positive()
    .default(24 * 60 * 60 * 1000),
  acceptableMaxAgeMs: z
    .number()
    .positive()
    .default(72 * 60 * 60 * 1000),
});
export type PricingFreshnessConfig = z.infer<typeof PricingFreshnessConfigSchema>;

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
  scoring: ScoringConfigSchema.default({}),
  pricing: PricingFreshnessConfigSchema.default({}),
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
