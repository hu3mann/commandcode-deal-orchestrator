import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import type { CandidateScore, CostBreakdown } from "../../src/domain/route.js";
import type { ModelTelemetry } from "../../src/domain/telemetry.js";
import { loadSeedPricingSnapshot } from "../../src/pricing/snapshot.js";
import { formatExplain } from "../../src/router/explain.js";
import { RouteError, makeTieBreak, selectRoute } from "../../src/router/select.js";

const now = new Date("2026-07-23T18:00:00Z");

function baseCost(expectedTotalCost: number): CostBreakdown {
  return {
    freshInputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 100,
    cacheWriteTokens: 0,
    freshInputCost: 0,
    cachedInputCost: 0,
    outputCost: 0,
    cacheWriteCost: 0,
    estimatedRequestCost: expectedTotalCost,
    expectedRetryCost: 0,
    expectedEscalationCost: 0,
    latencyPenalty: 0,
    expectedTotalCost,
    priceBasis: "current_rate",
    dealApplied: false,
    estimateLabel: "estimate",
  };
}

function candidate(overrides: Partial<CandidateScore> & { modelId: string }): CandidateScore {
  return {
    qualityTier: "capable",
    cost: baseCost(1),
    successRate: 0.9,
    averageLatencyMs: 1000,
    score: 1,
    preferred: false,
    ...overrides,
  };
}

function liveSet() {
  return new Set(
    loadSeedPricingSnapshot()
      .models.filter((m) => m.availability === "available")
      .map((m) => m.id)
      .filter((id) => id !== "tencent/Hy3"),
  );
}

describe("router", () => {
  it("selects cheapest eligible above floor for read_only", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: liveSet(),
      config,
      task,
      profile: "cheapest",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    expect(d.selectedModelId).toMatch(/deepseek-v4-flash|mimo-v2.5|hy3-paid/);
    expect(d.taskClass).toBe("read_only");
  });

  it("excludes expired free deal", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: null,
      config,
      task,
      profile: "cheapest",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
    });
    expect(d.rejected.some((r) => r.modelId === "tencent/Hy3")).toBe(true);
    expect(d.selectedModelId).not.toBe("tencent/Hy3");
  });

  it("rejects explicit unavailable model without fallback", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("do something");
    expect(() =>
      selectRoute({
        models: pricing.models,
        liveModelIds: liveSet(),
        config,
        task,
        pricingRetrievedAt: pricing.retrievedAt,
        now,
        cliModel: "not-a-real/model",
      }),
    ).toThrow(RouteError);
  });

  it("enforces quality floor for high_risk_review", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Security review of authentication permissions");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: liveSet(),
      config,
      task,
      profile: "cheapest",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    expect(d.qualityFloor).toBe("frontier");
    expect(["xai/grok-4.5", "claude-sonnet-5"]).toContain(d.selectedModelId);
  });

  it("respects max estimated cost", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Architecture redesign of multi-service platform");
    expect(() =>
      selectRoute({
        models: pricing.models,
        liveModelIds: liveSet(),
        config,
        task,
        profile: "frontier",
        pricingRetrievedAt: pricing.retrievedAt,
        now,
        maxEstimatedCost: 0.0000001,
      }),
    ).toThrow(/MAX_COST|max estimated/i);
  });

  it("explain includes key sections", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: liveSet(),
      config,
      task,
      profile: "balanced",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    const text = formatExplain(task, d);
    expect(text).toContain("Selected");
    expect(text).toContain("Candidates");
    expect(text).toContain("estimate");
  });

  it("manual override via marker", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("!model=xai/grok-4.5 summarize");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: liveSet(),
      config,
      task,
      pricingRetrievedAt: pricing.retrievedAt,
      now,
    });
    expect(d.selectedModelId).toBe("xai/grok-4.5");
    expect(d.overridesApplied.some((o) => o.includes("model"))).toBe(true);
  });

  // ── Defect 4: §21 tie-break must be a genuine 5-step total order ──
  describe("tie-break (makeTieBreak) — each step exercised in isolation", () => {
    const epsilon = 1e-9;

    it("step 1: lower adjusted expected cost wins, all else equal", () => {
      const tieBreak = makeTieBreak([], epsilon);
      const cheap = candidate({ modelId: "z-cheap", cost: baseCost(1) });
      const expensive = candidate({ modelId: "a-expensive", cost: baseCost(2) });
      expect([expensive, cheap].sort(tieBreak).map((c) => c.modelId)).toEqual([
        "z-cheap",
        "a-expensive",
      ]);
    });

    it("step 2: equal cost, higher smoothed success rate wins", () => {
      const tieBreak = makeTieBreak([], epsilon);
      const lowSr = candidate({ modelId: "z-low-sr", cost: baseCost(1), successRate: 0.5 });
      const highSr = candidate({ modelId: "a-high-sr", cost: baseCost(1), successRate: 0.9 });
      expect([lowSr, highSr].sort(tieBreak).map((c) => c.modelId)).toEqual([
        "a-high-sr",
        "z-low-sr",
      ]);
    });

    it("step 3: equal cost and success rate, lower average latency wins", () => {
      const tieBreak = makeTieBreak([], epsilon);
      const slow = candidate({
        modelId: "a-slow",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 5000,
      });
      const fast = candidate({
        modelId: "z-fast",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      expect([slow, fast].sort(tieBreak).map((c) => c.modelId)).toEqual(["z-fast", "a-slow"]);
    });

    it("step 4: equal cost, success rate, and latency — configured preference order wins", () => {
      // "not-preferred" lexically sorts before "preferred-model" (n < p), so this only
      // passes if preference order is actually consulted before the lexical fallback.
      const tieBreak = makeTieBreak(["preferred-model"], epsilon);
      const notPreferred = candidate({
        modelId: "not-preferred",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      const preferred = candidate({
        modelId: "preferred-model",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      expect([notPreferred, preferred].sort(tieBreak).map((c) => c.modelId)).toEqual([
        "preferred-model",
        "not-preferred",
      ]);
    });

    it("step 4: preference order ranks by configured list position, not just membership", () => {
      const tieBreak = makeTieBreak(["z-second-choice", "a-first-choice"], epsilon);
      const firstChoice = candidate({
        modelId: "a-first-choice",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      const secondChoice = candidate({
        modelId: "z-second-choice",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      // "z-second-choice" is listed first (index 0) in the preferred list, so it must win
      // even though it's lexically after "a-first-choice".
      expect([firstChoice, secondChoice].sort(tieBreak).map((c) => c.modelId)).toEqual([
        "z-second-choice",
        "a-first-choice",
      ]);
    });

    it("step 5: everything else equal — lexical exact model id is the final tiebreaker", () => {
      const tieBreak = makeTieBreak([], epsilon);
      const b = candidate({
        modelId: "b-model",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      const a = candidate({
        modelId: "a-model",
        cost: baseCost(1),
        successRate: 0.9,
        averageLatencyMs: 1000,
      });
      expect([b, a].sort(tieBreak).map((c) => c.modelId)).toEqual(["a-model", "b-model"]);
    });

    it("total order: fully identical candidates still sort deterministically both ways", () => {
      const tieBreak = makeTieBreak([], epsilon);
      const x = candidate({ modelId: "x", cost: baseCost(1) });
      const y = candidate({ modelId: "y", cost: baseCost(1) });
      expect(tieBreak(x, y)).toBeLessThan(0);
      expect(tieBreak(y, x)).toBeGreaterThan(0);
      expect(tieBreak(x, x)).toBe(0);
    });
  });

  // ── §21: selection must be deterministic independent of telemetry Map iteration order ──
  it("selection is deterministic regardless of telemetry Map insertion order", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    const availableModels = pricing.models.filter((m) => m.availability === "available");
    const entries: [string, ModelTelemetry][] = availableModels.map((m, i) => [
      m.id,
      {
        modelId: m.id,
        attempts: 10,
        successfulRuns: 10 - (i % 4),
        failedRuns: i % 4,
        timeouts: 0,
        toolFailures: 0,
        schemaFailures: 0,
        repairTurns: 0,
        testPassRate: 1,
        averageLatencyMs: 1000 + i * 137,
        estimatedCost: 0,
        operatorOverrides: 0,
      },
    ]);
    const forward = new Map(entries);
    const backward = new Map([...entries].reverse());
    const live = new Set(availableModels.map((m) => m.id));

    const d1 = selectRoute({
      models: pricing.models,
      liveModelIds: live,
      config,
      task,
      profile: "balanced",
      telemetry: forward,
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    const d2 = selectRoute({
      models: pricing.models,
      liveModelIds: live,
      config,
      task,
      profile: "balanced",
      telemetry: backward,
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    expect(d1.selectedModelId).toBe(d2.selectedModelId);
    expect(d1.candidates.map((c) => c.modelId)).toEqual(d2.candidates.map((c) => c.modelId));
  });

  // ── Defect 2: full pipeline fails closed when live catalog is unavailable ──
  it("selectRoute fails closed (throws NO_ELIGIBLE_MODEL) when live catalog is unavailable", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    try {
      selectRoute({
        models: pricing.models,
        liveModelIds: null,
        liveCatalogStatus: "unavailable",
        config,
        task,
        profile: "cheapest",
        pricingRetrievedAt: pricing.retrievedAt,
        now,
      });
      expect.fail("expected selectRoute to throw RouteError");
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).code).toBe("NO_ELIGIBLE_MODEL");
      expect((e as RouteError).message).toMatch(/live model catalog unavailable/i);
    }
  });

  // ── Defect 5: explain output surfaces the active scoring coefficients when given config ──
  it("explain prints active scoring coefficients and profile weights when config is supplied", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: liveSet(),
      config,
      task,
      profile: "balanced",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    const withoutConfig = formatExplain(task, d);
    expect(withoutConfig).not.toContain("Scoring configuration");

    const withConfig = formatExplain(task, d, config);
    expect(withConfig).toContain("Scoring configuration");
    expect(withConfig).toContain(`priorMean=${config.scoring.successRateSmoothing.priorMean}`);
    expect(withConfig).toContain(`Quality tier divisor: ${config.scoring.qualityTierDivisor}`);
    expect(withConfig).toContain("Profile weights (balanced)");
  });
});
