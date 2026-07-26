import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import type { ModelPricing } from "../../src/domain/model.js";
import type { ModelTelemetry } from "../../src/domain/telemetry.js";
import { filterEligible, resolveQualityFloor } from "../../src/router/eligibility.js";
import { scoreCandidates } from "../../src/router/scorer.js";

const now = new Date("2026-07-23T12:00:00Z");

describe("eligibility extras", () => {
  it("rejects unavailable and free when noFree", () => {
    const config = loadDefaultRoutingConfig();
    const models: ModelPricing[] = [
      {
        id: "a/free",
        contextWindow: 1000,
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
        contextWindow: 1000,
        inputPerMillion: 1,
        outputPerMillion: 1,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "unavailable",
      },
      {
        id: "c/ok",
        contextWindow: 1000,
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
        contextWindow: 1000,
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
        contextWindow: 1000,
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
        contextWindow: 1000,
        inputPerMillion: 0.1,
        outputPerMillion: 0.2,
        cacheReadPerMillion: 0,
        priceBasis: "current_rate",
        qualityTier: "economical",
        availability: "available",
      },
      {
        id: "m/real",
        contextWindow: 1000,
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
        contextWindow: 1000,
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
});
