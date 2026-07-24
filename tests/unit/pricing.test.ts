import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../../src/domain/model.js";
import { calculateRequestCost, resolveEffectiveRates } from "../../src/pricing/calculator.js";
import { loadSeedPricingSnapshot } from "../../src/pricing/snapshot.js";

const baseTokens = {
  freshInput: 1_000_000,
  cachedInput: 1_000_000,
  output: 1_000_000,
  cacheWrite: 0,
};

describe("pricing calculator", () => {
  it("does not double-discount post_discount rates", () => {
    const model: ModelPricing = {
      id: "deepseek/deepseek-v4-pro",
      contextWindow: 1_000_000,
      inputPerMillion: 0.435,
      outputPerMillion: 0.87,
      cacheReadPerMillion: 0.003625,
      priceBasis: "post_discount",
      qualityTier: "capable",
      availability: "available",
      deal: { type: "permanent_price_reduction", label: "75-percent-off", expiresAt: null },
    };
    const cost = calculateRequestCost(model, baseTokens);
    expect(cost.freshInputCost).toBeCloseTo(0.435, 6);
    expect(cost.outputCost).toBeCloseTo(0.87, 6);
    expect(cost.cachedInputCost).toBeCloseTo(0.003625, 6);
    expect(cost.dealApplied).toBe(true);
    expect(cost.priceBasis).toBe("post_discount");
    // If someone wrongly applied 75% again: 0.435*0.25 = 0.10875
    expect(cost.freshInputCost).not.toBeCloseTo(0.10875, 5);
  });

  it("excludes expired free deals via resolveEffectiveRates throw path in eligibility", () => {
    const model: ModelPricing = {
      id: "tencent/Hy3",
      contextWindow: 262000,
      inputPerMillion: 0,
      outputPerMillion: 0,
      cacheReadPerMillion: 0,
      priceBasis: "post_discount",
      qualityTier: "economical",
      availability: "available",
      deal: {
        type: "free",
        label: "historical",
        expiresAt: "2026-07-22T00:00:00-07:00",
      },
    };
    expect(() =>
      resolveEffectiveRates(model, baseTokens, new Date("2026-07-23T12:00:00Z")),
    ).toThrow(/expired/i);
  });

  it("rolls temporary intro rate to replacement", () => {
    const model: ModelPricing = {
      id: "claude-sonnet-5",
      contextWindow: 1_000_000,
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
      priceBasis: "temporary_introductory_rate",
      qualityTier: "frontier",
      availability: "available",
      rateExpiresAt: "2026-09-01T00:00:00-07:00",
      replacementRate: {
        inputPerMillion: 3,
        outputPerMillion: 15,
        cacheReadPerMillion: 0.3,
        cacheWritePerMillion: 3.75,
      },
    };
    const before = resolveEffectiveRates(model, baseTokens, new Date("2026-08-01T00:00:00Z"));
    expect(before.inputPerMillion).toBe(2);
    const after = resolveEffectiveRates(model, baseTokens, new Date("2026-09-02T00:00:00Z"));
    expect(after.inputPerMillion).toBe(3);
    expect(after.priceBasis).toBe("replacement_rate");
  });

  it("applies tiered context pricing", () => {
    const model: ModelPricing = {
      id: "minimaxai/minimax-m3",
      contextWindow: 1_000_000,
      priceBasis: "post_discount",
      qualityTier: "capable",
      availability: "available",
      tiers: [
        {
          maxContext: 512000,
          inputPerMillion: 0.3,
          outputPerMillion: 1.2,
          cacheReadPerMillion: 0.06,
        },
        {
          maxContext: 1000000,
          inputPerMillion: 0.3,
          outputPerMillion: 1.2,
          cacheReadPerMillion: 0.06,
        },
      ],
    };
    const rates = resolveEffectiveRates(model, {
      ...baseTokens,
      estimatedContext: 100_000,
    });
    expect(rates.inputPerMillion).toBe(0.3);
  });

  it("seed snapshot parses", () => {
    const snap = loadSeedPricingSnapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.models.some((m) => m.id === "xai/grok-4.5")).toBe(true);
    expect(snap.models.some((m) => m.id === "minimaxai/minimax-m3")).toBe(true);
  });
});
