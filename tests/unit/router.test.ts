import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { loadSeedPricingSnapshot } from "../../src/pricing/snapshot.js";
import { formatExplain } from "../../src/router/explain.js";
import { RouteError, selectRoute } from "../../src/router/select.js";

const now = new Date("2026-07-23T18:00:00Z");

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
});
