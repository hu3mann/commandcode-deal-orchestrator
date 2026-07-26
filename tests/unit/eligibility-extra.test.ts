import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import type { ModelPricing } from "../../src/domain/model.js";
import type { ClassifiedTask } from "../../src/domain/task.js";
import type { ModelTelemetry } from "../../src/domain/telemetry.js";
import { filterEligible, resolveQualityFloor } from "../../src/router/eligibility.js";
import { scoreCandidates, smoothedSuccessRate } from "../../src/router/scorer.js";

const now = new Date("2026-07-23T12:00:00Z");

function baseTask(overrides: Partial<ClassifiedTask> = {}): ClassifiedTask {
  return {
    originalText: "task",
    cleanedText: "task",
    taskClass: "standard_build",
    riskLevel: "low",
    signals: [],
    overrides: {},
    requiredCapabilities: [],
    ...overrides,
  };
}

describe("eligibility extras", () => {
  it("rejects unavailable and free when noFree", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "a/free",
        contextWindow: 1_000_000,
        inputPerMillion: 0,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        priceBasis: "post_discount",
        qualityTier: "economical",
        availability: "available",
        deal: { type: "free", label: "f", expiresAt: null },
      },
      {
        id: "b/gone",
        contextWindow: 1_000_000,
        inputPerMillion: 1,
        outputPerMillion: 1,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "unavailable",
      },
      {
        id: "c/ok",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const task = classifyTask("list files");
    const r = filterEligible({
      models,
      liveModelIds: new Set(["a/free", "b/gone", "c/ok"]),
      config,
      task,
      qualityFloor: "economical",
      noFree: true,
      now,
    });
    expect(r.eligible.map((m) => m.id)).toEqual(["c/ok"]);
  });

  it("explicit expired deal fails", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "old/free",
        contextWindow: 1_000_000,
        inputPerMillion: 0,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        priceBasis: "post_discount",
        qualityTier: "economical",
        availability: "available",
        deal: { type: "free", label: "x", expiresAt: "2020-01-01T00:00:00Z" },
      },
    ];
    const r = filterEligible({
      models,
      liveModelIds: new Set(["old/free"]),
      config,
      task: classifyTask("hi"),
      qualityFloor: "economical",
      noFree: false,
      now,
      explicitModel: "old/free",
    });
    expect(r.eligible).toHaveLength(0);
  });

  it("temporary rate without replacement rejected", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "temp/m",
        contextWindow: 1_000_000,
        inputPerMillion: 1,
        outputPerMillion: 1,
        cacheReadPerMillion: 0,
        priceBasis: "temporary_introductory_rate",
        qualityTier: "frontier",
        availability: "available",
        rateExpiresAt: "2020-01-01T00:00:00Z",
      },
    ];
    const r = filterEligible({
      models,
      liveModelIds: null,
      config,
      task: classifyTask("architecture redesign"),
      qualityFloor: "frontier",
      noFree: false,
      now,
    });
    expect(r.eligible).toHaveLength(0);
  });

  it("resolveQualityFloor", () => {
    const config = loadDefaultRoutingConfig();
    expect(resolveQualityFloor(config, "high_risk_review")).toBe("frontier");
  });

  it("rejects model not in live catalog when liveModelIds available", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "m/ghost",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
      {
        id: "m/real",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const task = classifyTask("list files");
    const r = filterEligible({
      models,
      liveModelIds: new Set(["m/real"]),
      config,
      task,
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible.map((m) => m.id)).toEqual(["m/real"]);
    expect(r.rejected.some((rr) => rr.modelId === "m/ghost")).toBe(true);
  });

  it("rejects high_risk_review with economical tier when no explicit override", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "m/eco",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    // Ensure it's listed in the economical quality tier
    config.quality_tiers.economical.push("m/eco");
    // qualityFloor must be <= economical so it doesn't get caught by floor check
    // high_risk has floor=frontier by default, so we need to set floor=economical to trigger line 112-122
    const task = classifyTask("authentication security review");
    expect(task.taskClass).toBe("high_risk_review");
    const r = filterEligible({
      models,
      liveModelIds: new Set(["m/eco"]),
      config,
      task,
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible).toHaveLength(0);
    expect(
      r.rejected.some((rr) => rr.reason.includes("high_risk_review cannot use economical tier")),
    ).toBe(true);
  });

  it("scorer uses telemetry failure rates", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "m1",
        contextWindow: 100000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const tel = new Map<string, ModelTelemetry>([
      [
        "m1",
        {
          modelId: "m1",
          attempts: 10,
          successfulRuns: 2,
          failedRuns: 8,
          timeouts: 0,
          toolFailures: 0,
          schemaFailures: 0,
          repairTurns: 0,
          testPassRate: 0.2,
          averageLatencyMs: 5000,
          estimatedCost: 1,
          operatorOverrides: 0,
        },
      ],
    ]);
    const scores = scoreCandidates({
      models,
      task: classifyTask("summarize"),
      config,
      profile: "balanced",
      telemetry: tel,
      preferred: [],
      now,
    });
    expect(scores[0]!.cost.expectedRetryCost).toBeGreaterThan(0);
  });

  // ── Defect 1: §17 context-window hard eligibility gate ──
  it("rejects a model whose context window is smaller than the estimated request context", () => {
    const config = loadDefaultRoutingConfig();
    // standard_build token_priors total 12000+80000+6000 = 98000 estimated context tokens.
    const models: ModelPricing[] = [
      {
        id: "too/small",
        contextWindow: 50_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "capable",
        availability: "available",
      },
      {
        id: "big/enough",
        contextWindow: 200_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "capable",
        availability: "available",
      },
    ];
    const r = filterEligible({
      models,
      liveModelIds: new Set(["too/small", "big/enough"]),
      config,
      task: baseTask({ taskClass: "standard_build" }),
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible.map((m) => m.id)).toEqual(["big/enough"]);
    const rejection = r.rejected.find((rr) => rr.modelId === "too/small");
    expect(rejection?.reason).toMatch(/context window/i);
  });

  // ── Defect 1: §17 required-capabilities hard eligibility gate ──
  it("gates on required capabilities: rejects a declared mismatch, accepts a declared match, and does not punish absent capability metadata", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "cap/missing",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "capable",
        availability: "available",
        capabilities: ["agentic_coding"],
      } as ModelPricing,
      {
        id: "cap/has-it",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "capable",
        availability: "available",
        capabilities: ["strong_reasoning", "agentic_coding"],
      } as ModelPricing,
      {
        id: "cap/undeclared",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "capable",
        availability: "available",
        // No `capabilities` field at all: absent metadata is UNKNOWN, not "lacks it", and
        // must not be silently rejected (documented choice — see router/eligibility.ts).
      },
    ];
    const r = filterEligible({
      models,
      liveModelIds: new Set(["cap/missing", "cap/has-it", "cap/undeclared"]),
      config,
      task: baseTask({ taskClass: "architecture", requiredCapabilities: ["strong_reasoning"] }),
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible.map((m) => m.id).sort()).toEqual(["cap/has-it", "cap/undeclared"]);
    const rejection = r.rejected.find((rr) => rr.modelId === "cap/missing");
    expect(rejection?.reason).toMatch(/missing required capabilities/i);
    // The context-window rejection reason and the capability rejection reason must be
    // distinguishable from one another.
    expect(rejection?.reason).not.toMatch(/context window/i);
  });

  // ── Defect 2: live catalog unavailable must fail CLOSED, not open ──
  it("fails closed (rejects every model) when the live catalog is unavailable, rather than treating the static seed as live-verified", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "seed/one",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
      {
        id: "seed/two",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const r = filterEligible({
      models,
      // liveModelIds is null exactly as it would be after a failed fetch — the bug (defect
      // 2) was treating this the same as "no live check requested", which is why the new
      // liveCatalogStatus field exists to disambiguate.
      liveModelIds: null,
      liveCatalogStatus: "unavailable",
      config,
      task: baseTask({ taskClass: "read_only" }),
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    for (const rr of r.rejected) {
      expect(rr.reason).toMatch(/live model catalog unavailable/i);
    }
  });

  it("leaves legacy callers unaffected: liveCatalogStatus omitted + liveModelIds null still behaves permissively", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "seed/one",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const r = filterEligible({
      models,
      liveModelIds: null,
      config,
      task: baseTask({ taskClass: "read_only" }),
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible.map((m) => m.id)).toEqual(["seed/one"]);
  });

  // ── Defect 6: stale pricing snapshot + deal-affected model must be rejected ──
  it("rejects a deal-affected model on a stale pricing snapshot, but keeps a non-deal model eligible", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "stale/has-deal",
        contextWindow: 1_000_000,
        inputPerMillion: 0,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        priceBasis: "post_discount",
        qualityTier: "economical",
        availability: "available",
        deal: { type: "free", label: "f", expiresAt: null },
      },
      {
        id: "stale/no-deal",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    // now (2026-07-23T12:00Z) minus a retrievedAt over three weeks earlier is well past the
    // default 72h acceptableMaxAgeMs staleness threshold.
    const r = filterEligible({
      models,
      liveModelIds: new Set(["stale/has-deal", "stale/no-deal"]),
      config,
      task: baseTask({ taskClass: "read_only" }),
      qualityFloor: "economical",
      noFree: false,
      now,
      pricingRetrievedAt: "2026-07-01T00:00:00Z",
    });
    expect(r.eligible.map((m) => m.id)).toEqual(["stale/no-deal"]);
    const rejection = r.rejected.find((rr) => rr.modelId === "stale/has-deal");
    expect(rejection?.reason).toMatch(/stale/i);
  });

  it("without a pricingRetrievedAt, the staleness gate is skipped entirely (backward compatible)", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "no-staleness-check",
        contextWindow: 1_000_000,
        inputPerMillion: 0,
        outputPerMillion: 0,
        cacheReadPerMillion: 0,
        priceBasis: "post_discount",
        qualityTier: "economical",
        availability: "available",
        deal: { type: "free", label: "f", expiresAt: null },
      },
    ];
    const r = filterEligible({
      models,
      liveModelIds: new Set(["no-staleness-check"]),
      config,
      task: baseTask({ taskClass: "read_only" }),
      qualityFloor: "economical",
      noFree: false,
      now,
    });
    expect(r.eligible.map((m) => m.id)).toEqual(["no-staleness-check"]);
  });

  // ── Defect 3: success-rate smoothing must not zero out on a single failure ──
  it("smoothed success rate: one attempt with one failure is pulled toward the neutral prior, not zeroed", () => {
    const config = loadDefaultRoutingConfig();
    const smoothing = config.scoring.successRateSmoothing;
    const oneFailure: ModelTelemetry = {
      modelId: "m",
      attempts: 1,
      successfulRuns: 0,
      failedRuns: 1,
      timeouts: 0,
      toolFailures: 0,
      schemaFailures: 0,
      repairTurns: 0,
      testPassRate: 0,
      averageLatencyMs: 1000,
      estimatedCost: 0,
      operatorOverrides: 0,
    };
    const sr = smoothedSuccessRate(oneFailure, smoothing);
    // Raw ratio would be 0/1 = 0. Bayesian smoothing with the default prior
    // (priorMean=0.85, priorWeight=5) gives (0 + 0.85*5) / (1 + 5) = 4.25/6.
    expect(sr).toBeCloseTo(
      (0 + smoothing.priorMean * smoothing.priorWeight) / (1 + smoothing.priorWeight),
      10,
    );
    expect(sr).toBeGreaterThan(0.5);
    expect(sr).not.toBe(0);

    // The same value must be what scoreCandidates reports and scores with (§21 tie-break
    // step 2 requires the *smoothed* value, not the raw ratio).
    const models: ModelPricing[] = [
      {
        id: "m",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const scores = scoreCandidates({
      models,
      task: classifyTask("summarize"),
      config,
      profile: "balanced",
      telemetry: new Map([["m", oneFailure]]),
      preferred: [],
      now,
    });
    expect(scores[0]!.successRate).toBeCloseTo(sr, 10);
    expect(scores[0]!.successRate).not.toBe(0);
  });

  // ── Defect 5: scoring coefficients must be config-driven, not opaque literals ──
  it("scoring coefficients are read from config: changing defaultAverageLatencyMs changes the score for a model with no telemetry", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "m",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    const task = classifyTask("summarize");
    const before = scoreCandidates({
      models,
      task,
      config,
      profile: "balanced",
      telemetry: new Map(),
      preferred: [],
      now,
    });
    const configWithDifferentLatency = {
      ...config,
      scoring: {
        ...config.scoring,
        defaultAverageLatencyMs: config.scoring.defaultAverageLatencyMs * 10,
      },
    };
    const after = scoreCandidates({
      models,
      task,
      config: configWithDifferentLatency,
      profile: "balanced",
      telemetry: new Map(),
      preferred: [],
      now,
    });
    expect(after[0]!.averageLatencyMs).toBe(before[0]!.averageLatencyMs * 10);
    expect(after[0]!.score).not.toBe(before[0]!.score);
  });

  it("scoring coefficients are read from config: changing qualityTierDivisor changes the score", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "m",
        contextWindow: 1_000_000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "frontier",
        availability: "available",
      },
    ];
    const task = classifyTask("summarize");
    const before = scoreCandidates({
      models,
      task,
      config,
      profile: "balanced",
      telemetry: new Map(),
      preferred: [],
      now,
    });
    const configWithDifferentDivisor = {
      ...config,
      scoring: { ...config.scoring, qualityTierDivisor: config.scoring.qualityTierDivisor * 2 },
    };
    const after = scoreCandidates({
      models,
      task,
      config: configWithDifferentDivisor,
      profile: "balanced",
      telemetry: new Map(),
      preferred: [],
      now,
    });
    expect(after[0]!.score).not.toBe(before[0]!.score);
  });
});
