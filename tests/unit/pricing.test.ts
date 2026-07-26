import { describe, expect, it } from "vitest";
import { isDealExpired } from "../../src/domain/deal.js";
import type { ModelPricing } from "../../src/domain/model.js";
import {
  calculateRequestCost,
  classifyRateKind,
  resolveEffectiveRates,
} from "../../src/pricing/calculator.js";
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

  // ── §14 multiplier deals + the real (not decorative) double-discount guard ──

  it("applies a multiplier deal to a genuinely pre-discount (current_rate) rate", () => {
    const model: ModelPricing = {
      id: "usage/4x-deal",
      contextWindow: 100_000,
      inputPerMillion: 2,
      outputPerMillion: 8,
      cacheReadPerMillion: 0.4,
      priceBasis: "current_rate",
      qualityTier: "capable",
      availability: "available",
      deal: {
        type: "permanent_price_reduction",
        kind: "multiplier",
        multiplier: 4,
        label: "4x-usage",
        expiresAt: null,
      },
    };
    expect(classifyRateKind(model)).toBe("PRE_DISCOUNT_RATE");
    const cost = calculateRequestCost(model, baseTokens);
    expect(cost.freshInputCost).toBeCloseTo(0.5, 6); // 2 / 4
    expect(cost.outputCost).toBeCloseTo(2, 6); // 8 / 4
    expect(cost.priceBasis).toBe("post_discount");
    expect(cost.dealApplied).toBe(true);
  });

  it("refuses to apply a multiplier deal on top of an already post-discount rate (real double-discount guard)", () => {
    const model: ModelPricing = {
      id: "usage/already-discounted",
      contextWindow: 100_000,
      inputPerMillion: 0.5,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.1,
      priceBasis: "post_discount",
      qualityTier: "capable",
      availability: "available",
      deal: {
        type: "permanent_price_reduction",
        kind: "multiplier",
        multiplier: 4,
        label: "stale-4x-usage",
        expiresAt: null,
      },
    };
    expect(classifyRateKind(model)).toBe("POST_DISCOUNT_RATE");
    const cost = calculateRequestCost(model, baseTokens);
    // Guard must refuse to re-apply the multiplier: rate stays exactly as given.
    expect(cost.freshInputCost).toBeCloseTo(0.5, 6);
    // If the guard were absent/removed, this would incorrectly be 0.5 / 4 = 0.125.
    // (Verified manually: commenting out the `rateKind === "PRE_DISCOUNT_RATE"` guard in
    // resolveEffectiveRates makes this exact assertion fail.)
    expect(cost.freshInputCost).not.toBeCloseTo(0.125, 6);
  });

  it("resolves a multiplier deal with no usable multiplier to UNKNOWN_RATE and makes the model ineligible", () => {
    const model: ModelPricing = {
      id: "broken/multiplier",
      contextWindow: 1000,
      inputPerMillion: 1,
      outputPerMillion: 1,
      cacheReadPerMillion: 0,
      priceBasis: "current_rate",
      qualityTier: "economical",
      availability: "available",
      deal: {
        type: "permanent_price_reduction",
        kind: "multiplier",
        // multiplier intentionally omitted: unclassifiable.
        label: "broken-usage-deal",
        expiresAt: null,
      },
    };
    expect(classifyRateKind(model)).toBe("UNKNOWN_RATE");
    expect(() => resolveEffectiveRates(model, baseTokens)).toThrow(/UNKNOWN_RATE/);
  });

  // ── §14 startsAt gate: a deal must not be applied before it begins ──

  it("does not apply a free deal whose startsAt is in the future", () => {
    const now = new Date("2026-07-26T00:00:00Z");
    const model: ModelPricing = {
      id: "future/free",
      contextWindow: 1000,
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0.1,
      priceBasis: "current_rate",
      qualityTier: "economical",
      availability: "available",
      deal: {
        type: "free",
        label: "upcoming-free",
        expiresAt: null,
        startsAt: "2099-01-01T00:00:00Z",
      },
    };
    expect(classifyRateKind(model, now)).toBe("PRE_DISCOUNT_RATE");
    const cost = calculateRequestCost(model, baseTokens, { now });
    // Deal hasn't started yet: model must still be priced at its normal rate, not free.
    expect(cost.freshInputCost).toBeCloseTo(1, 6);
    expect(cost.outputCost).toBeCloseTo(2, 6);
  });

  // ── §15/§14 expiry boundary: inclusive, and offset-agnostic ──

  it("expiry boundary is inclusive: a deal is valid through and including the exact expiry instant", () => {
    expect(isDealExpired("2026-01-01T00:00:00Z", new Date("2026-01-01T00:00:00Z"))).toBe(false);
    expect(isDealExpired("2026-01-01T00:00:00Z", new Date("2026-01-01T00:00:00.001Z"))).toBe(true);
  });

  it("treats two differently-offset representations of the same instant as equal at the boundary", () => {
    // 2026-08-02T00:00:00-07:00 and 2026-08-02T07:00:00Z name the exact same instant.
    expect(isDealExpired("2026-08-02T00:00:00-07:00", new Date("2026-08-02T07:00:00Z"))).toBe(
      false,
    );
    expect(isDealExpired("2026-08-02T00:00:00-07:00", new Date("2026-08-02T07:00:00.001Z"))).toBe(
      true,
    );
  });
});
