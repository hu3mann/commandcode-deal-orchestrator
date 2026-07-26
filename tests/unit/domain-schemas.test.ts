import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { resolveDealKind } from "../../src/domain/deal.js";
import type { Deal } from "../../src/domain/model.js";
import {
  CandidateScoreSchema,
  CostBreakdownSchema,
  RejectionReasonSchema,
  RouteDecisionSchema,
} from "../../src/domain/route.js";
import { loadSeedPricingSnapshot } from "../../src/pricing/snapshot.js";
import { selectRoute } from "../../src/router/select.js";

const now = new Date("2026-07-23T18:00:00Z");

/**
 * These schemas are the declared contract for what the router produces. They were
 * previously never parsed against at runtime, so the router's actual output and its
 * declared shape could drift apart silently. Each test here parses REAL router output
 * rather than a hand-built fixture, so a field added to or dropped from a decision
 * without a matching schema change fails the suite.
 */
describe("domain route schemas match real router output", () => {
  function realDecision() {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository");
    return selectRoute({
      task,
      config,
      models: pricing.models,
      profile: "balanced",
      telemetry: new Map(),
      now,
      pricingRetrievedAt: pricing.retrievedAt,
      liveModelIds: new Set(pricing.models.map((m) => m.id)),
      liveCatalogStatus: "available",
    });
  }

  it("a real RouteDecision satisfies RouteDecisionSchema exactly", () => {
    const parsed = RouteDecisionSchema.safeParse(realDecision());
    if (!parsed.success) {
      throw new Error(`RouteDecision drifted from its schema: ${parsed.error.message}`);
    }
    expect(parsed.success).toBe(true);
  });

  it("every candidate and cost breakdown in a real decision satisfies its schema", () => {
    const decision = realDecision();
    expect(decision.candidates.length).toBeGreaterThan(0);
    for (const candidate of decision.candidates) {
      expect(CandidateScoreSchema.safeParse(candidate).success).toBe(true);
      expect(CostBreakdownSchema.safeParse(candidate.cost).success).toBe(true);
    }
  });

  it("rejection reasons produced by the router satisfy RejectionReasonSchema", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    // A frontier-floor task rejects the economical tier, guaranteeing rejections exist.
    const task = classifyTask("Design the authentication architecture across three services");
    const decision = selectRoute({
      task,
      config,
      models: pricing.models,
      profile: "frontier",
      telemetry: new Map(),
      now,
      pricingRetrievedAt: pricing.retrievedAt,
      liveModelIds: new Set(pricing.models.map((m) => m.id)),
      liveCatalogStatus: "available",
    });
    expect(decision.rejected.length).toBeGreaterThan(0);
    for (const rejection of decision.rejected) {
      expect(RejectionReasonSchema.safeParse(rejection).success).toBe(true);
      expect(rejection.reason.length).toBeGreaterThan(0);
    }
  });

  it("rejects a decision missing a required field", () => {
    const decision = realDecision() as Record<string, unknown>;
    const { tieBreakRule, ...withoutTieBreak } = decision;
    expect(tieBreakRule).toBeTruthy();
    expect(RouteDecisionSchema.safeParse(withoutTieBreak).success).toBe(false);
  });
});

describe("resolveDealKind covers every legacy deal type", () => {
  const cases: Array<[Deal["type"], string]> = [
    ["free", "free"],
    ["permanent_price_reduction", "permanent_rate"],
    ["temporary_rate", "temporary_rate"],
  ];

  for (const [type, expected] of cases) {
    it(`maps legacy type "${type}" to kind "${expected}"`, () => {
      expect(resolveDealKind({ type, label: "t" } as Deal)).toBe(expected);
    });
  }

  it("prefers an explicit kind over the legacy type mapping", () => {
    expect(resolveDealKind({ type: "free", kind: "multiplier", label: "t" } as Deal)).toBe(
      "multiplier",
    );
  });

  it("falls back to permanent_rate for a type outside the schema enum", () => {
    // Unreachable for schema-valid data; asserts the defensive default rather than
    // leaving it as an untested branch.
    expect(resolveDealKind({ type: "not-a-real-type", label: "t" } as unknown as Deal)).toBe(
      "permanent_rate",
    );
  });
});
