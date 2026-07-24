import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { ConfigError, deepMerge } from "../../src/config/merge.js";
import type { ModelPricing } from "../../src/domain/model.js";
import { calculateRequestCost, resolveEffectiveRates } from "../../src/pricing/calculator.js";
import { refreshPricingFromOfficial } from "../../src/pricing/refresh.js";
import { loadSeedPricingSnapshot } from "../../src/pricing/snapshot.js";
import { filterEligible } from "../../src/router/eligibility.js";
import { formatExplain } from "../../src/router/explain.js";
import { RouteError, selectRoute } from "../../src/router/select.js";
import { assertSafeModelId, buildCmdArgv } from "../../src/security/command-policy.js";

const now = new Date("2026-07-23T18:00:00Z");

describe("branch coverage", () => {
  it("high_risk never routes economical without override", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "eco/only",
        contextWindow: 1000,
        inputPerMillion: 0.01,
        outputPerMillion: 0.01,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
    ];
    // force eco into economical tier list
    config.quality_tiers.economical.push("eco/only");
    const task = classifyTask("Security review of authentication permissions");
    const r = filterEligible({
      models,
      liveModelIds: new Set(["eco/only"]),
      config,
      task,
      qualityFloor: "frontier",
      noFree: false,
      now,
    });
    expect(r.eligible).toHaveLength(0);
  });

  it("select frontier profile prefers frontier tier", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const live = new Set(
      pricing.models.filter((m) => m.availability === "available").map((m) => m.id),
    );
    const task = classifyTask("Architecture redesign for multi-service platform");
    const d = selectRoute({
      models: pricing.models,
      liveModelIds: live,
      config,
      task,
      profile: "frontier",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    expect(["xai/grok-4.5", "claude-sonnet-5"]).toContain(d.selectedModelId);
  });

  it("select throws NO_ELIGIBLE when empty", () => {
    const config = loadDefaultRoutingConfig();
    expect(() =>
      selectRoute({
        models: [],
        liveModelIds: new Set(),
        config,
        task: classifyTask("hi"),
        pricingRetrievedAt: new Date().toISOString(),
        now,
      }),
    ).toThrow(RouteError);
  });

  it("calculator expired_deal availability throws", () => {
    expect(() =>
      resolveEffectiveRates(
        {
          id: "x",
          contextWindow: 1,
          inputPerMillion: 0,
          outputPerMillion: 0,
          cacheReadPerMillion: 0,
          priceBasis: "post_discount",
          qualityTier: "economical",
          availability: "expired_deal",
        },
        { freshInput: 1, cachedInput: 0, output: 1, cacheWrite: 0 },
      ),
    ).toThrow();
  });

  it("calculator picks last tier for huge context", () => {
    const cost = calculateRequestCost(
      {
        id: "t",
        contextWindow: 1_000_000,
        priceBasis: "post_discount",
        qualityTier: "capable",
        availability: "available",
        tiers: [
          {
            maxContext: 100,
            inputPerMillion: 1,
            outputPerMillion: 1,
            cacheReadPerMillion: 0,
          },
          {
            maxContext: 1000,
            inputPerMillion: 2,
            outputPerMillion: 2,
            cacheReadPerMillion: 0,
          },
        ],
      },
      {
        freshInput: 10,
        cachedInput: 0,
        output: 10,
        cacheWrite: 0,
        estimatedContext: 99999,
      },
    );
    expect(cost.freshInputCost).toBeCloseTo((10 / 1e6) * 2, 10);
  });

  it("assertSafeModelId empty and path traversal", () => {
    expect(() => assertSafeModelId("")).toThrow();
    expect(() => assertSafeModelId("a/../b")).toThrow();
    expect(() => assertSafeModelId("x".repeat(201))).toThrow();
  });

  it("buildCmdArgv skip onboarding false path", () => {
    const argv = buildCmdArgv({
      model: "deepseek/deepseek-v4-flash",
      skipOnboarding: false,
      print: false,
    });
    expect(argv).not.toContain("--skip-onboarding");
    expect(argv).not.toContain("--print");
  });

  it("deepMerge nested non-object overwrite", () => {
    const out = deepMerge({ a: 1 }, { a: 2 });
    expect(out.a).toBe(2);
  });

  it("deepMerge security key outside security ok", () => {
    const out = deepMerge({ token: "x" }, { token: "y" });
    expect(out.token).toBe("y");
  });

  it("explain with empty rejected", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const live = new Set(["deepseek/deepseek-v4-flash", "xiaomi/mimo-v2.5"]);
    const task = classifyTask("Summarize docs");
    const d = selectRoute({
      models: pricing.models.filter((m) => live.has(m.id)),
      liveModelIds: live,
      config,
      task,
      profile: "cheapest",
      pricingRetrievedAt: pricing.retrievedAt,
      now,
      noFree: true,
    });
    const text = formatExplain(task, d);
    expect(text).toMatch(/Rejected/);
  });

  it("refresh network success path", async () => {
    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () =>
        ({
          ok: true,
          text: async () => "<html>ok</html>",
        }) as Response,
    });
    expect(r.ok).toBe(true);
  });

  it("refresh network http fail", async () => {
    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () => ({ ok: false, status: 500 }) as Response,
    });
    expect(r.ok).toBe(false);
  });

  it("classify monorepo complex", () => {
    const t = classifyTask("implement feature", {
      monorepo: true,
      trackedFiles: 900,
      packageCount: 5,
      hasMigrations: true,
      hasAuthModules: true,
      hasInfra: true,
    });
    expect(["complex_build", "high_risk_review", "standard_build"]).toContain(t.taskClass);
  });

  it("throws ConfigError name", () => {
    const e = new ConfigError("x");
    expect(e.name).toBe("ConfigError");
    expect(e.code).toBe("CONFIG_INVALID");
  });
});
