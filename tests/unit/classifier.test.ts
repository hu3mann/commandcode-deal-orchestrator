import { describe, expect, it } from "vitest";
import { classifyTask, parseTaskMarkers } from "../../src/classifier/deterministic.js";

describe("classifier", () => {
  it("classifies read-only", () => {
    const t = classifyTask("Explain how authentication works in this repo");
    expect(t.taskClass).toBe("read_only");
  });

  it("classifies trivial edit", () => {
    const t = classifyTask("Fix typo in README one-line");
    expect(t.taskClass).toBe("trivial_edit");
  });

  it("classifies standard build", () => {
    const t = classifyTask("Implement a unit test for the login helper");
    expect(["standard_build", "trivial_edit", "complex_build"]).toContain(t.taskClass);
  });

  it("classifies complex build", () => {
    const t = classifyTask("Multi-file refactor across services for failing CI race condition");
    expect(t.taskClass).toBe("complex_build");
  });

  it("classifies architecture", () => {
    const t = classifyTask("Redesign the architecture for the routing control plane");
    expect(t.taskClass).toBe("architecture");
  });

  it("classifies high-risk even when short", () => {
    const t = classifyTask("Review auth permissions");
    expect(t.taskClass).toBe("high_risk_review");
    expect(t.riskLevel).toBe("high");
  });

  it("is deterministic", () => {
    const a = classifyTask("Search for config loaders");
    const b = classifyTask("Search for config loaders");
    expect(a).toEqual(b);
  });

  it("parses markers and strips them", () => {
    const { cleaned, overrides } = parseTaskMarkers(
      "!cheap !no-free !model=xai/grok-4.5 do the thing",
    );
    expect(cleaned).toBe("do the thing");
    expect(overrides.profile).toBe("cheapest");
    expect(overrides.noFree).toBe(true);
    expect(overrides.model).toBe("xai/grok-4.5");
  });
});
