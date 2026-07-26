import { describe, expect, it } from "vitest";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import type { ModelPricing } from "../../src/domain/model.js";
import type { ClassifiedTask } from "../../src/domain/task.js";
import { filterEligible } from "../../src/router/eligibility.js";

const now = new Date("2026-07-23T12:00:00Z");

function task(overrides: Partial<ClassifiedTask> = {}): ClassifiedTask {
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

function model(overrides: Partial<ModelPricing> & { id: string }): ModelPricing {
  return {
    contextWindow: 1_000_000,
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: 0,
    priceBasis: "current_rate",
    qualityTier: "capable",
    availability: "available",
    ...overrides,
  } as ModelPricing;
}

function run(models: ModelPricing[], explicitModel: string, extra: Record<string, unknown> = {}) {
  return filterEligible({
    models,
    explicitModel,
    liveModelIds: new Set(models.map((m) => m.id)),
    config: loadDefaultRoutingConfig(),
    task: task(),
    now,
    pricingRetrievedAt: now.toISOString(),
    ...extra,
  } as Parameters<typeof filterEligible>[0]);
}

/**
 * §2.3 / §17: an explicitly requested model must fail closed with a specific reason
 * rather than silently falling back to a different model. Each rejection path below is
 * a distinct guard; before these tests the explicit-model branch was the least-covered
 * part of eligibility, so a regression in any one of them would have gone unnoticed.
 */
describe("explicit --model rejection paths each fail closed with a distinct reason", () => {
  it("rejects a model absent from the pricing snapshot", () => {
    const r = run([model({ id: "a/known" })], "a/unknown");
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/not present in pricing snapshot/);
  });

  it("fails closed when the live catalog could not be read", () => {
    const r = run([model({ id: "a/known" })], "a/known", { liveCatalogStatus: "unavailable" });
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/live model catalog unavailable/);
  });

  it("rejects a model missing from the live catalog", () => {
    const m = model({ id: "a/known" });
    const r = run([m], "a/known", { liveModelIds: new Set(["b/other"]) });
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/not in live CommandCode catalog/);
  });

  it("rejects a model whose deal has expired", () => {
    const m = model({
      id: "a/expired",
      deal: { type: "free", label: "f", expiresAt: "2026-01-01T00:00:00Z" },
    });
    const r = run([m], "a/expired");
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/deal expired/);
  });

  it("rejects a model marked expired_deal by availability", () => {
    const m = model({ id: "a/marked", availability: "expired_deal" });
    const r = run([m], "a/marked");
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/deal expired/);
  });

  it("rejects a temporary rate past expiry with no replacement rate", () => {
    const m = model({
      id: "a/intro",
      priceBasis: "temporary_introductory_rate",
      rateExpiresAt: "2026-01-01T00:00:00Z",
    });
    const r = run([m], "a/intro");
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/temporary rate expired without replacement/);
  });

  it("rejects a model whose context window is smaller than the estimated request", () => {
    const m = model({ id: "a/tiny", contextWindow: 10 });
    const r = run([m], "a/tiny");
    expect(r.eligible).toHaveLength(0);
    expect(r.rejected[0]?.reason).toMatch(/context/i);
  });

  it("accepts an explicit model that clears every gate", () => {
    const m = model({ id: "a/good" });
    const r = run([m], "a/good");
    expect(r.eligible.map((e) => e.id)).toEqual(["a/good"]);
    expect(r.rejected).toHaveLength(0);
  });
});
