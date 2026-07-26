import { describe, expect, it } from "vitest";
import { classifyTask, parseTaskMarkers } from "../../src/classifier/deterministic.js";
import { HIGH_RISK_SIGNALS } from "../../src/classifier/signals.js";

describe("classifier", () => {
  it("classifies read-only", () => {
    // NOTE: this prompt was originally "Explain how authentication works in this repo",
    // which is exactly the "risk word mentioned incidentally in a clearly read-only
    // framing" judgment call from the §16.6 packet. Per the packet's explicit bias
    // toward over- rather than under-classifying risk, that framing now correctly
    // elevates to high_risk_review (covered by its own test below). This test keeps a
    // genuinely benign prompt with no risk keywords to confirm read_only still works.
    const t = classifyTask("Explain how the routing logic works in this repo");
    expect(t.taskClass).toBe("read_only");
    expect(t.riskLevel).toBe("low");
  });

  it("classifies trivial edit", () => {
    const t = classifyTask("Fix typo in README one-line");
    expect(t.taskClass).toBe("trivial_edit");
  });

  it("classifies standard build", () => {
    const t = classifyTask("Implement a unit test for the login helper");
    expect(t.taskClass).toBe("standard_build");
  });

  it("classifies complex build", () => {
    const t = classifyTask("Multi-file refactor across services for failing CI race condition");
    expect(t.taskClass).toBe("complex_build");
  });

  it("classifies architecture", () => {
    const t = classifyTask("Redesign the architecture for the routing control plane");
    expect(t.taskClass).toBe("architecture");
  });

  it("classifies high-risk even when short (with an explicit review verb)", () => {
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

  describe("mandated high-risk keywords (§16.6 defect 1)", () => {
    // Each of these was previously entirely absent from signals.ts (or, for
    // "permission", shadowed by only the plural "permissions" being present combined
    // with naive substring matching), so these prompts used to come back with
    // riskLevel=low and zero signal hits. Each prompt deliberately has NO
    // review/change verb, so a pass here also exercises defect 2's brevity-override
    // requirement at the same time.
    it('detects "permission" (singular)', () => {
      const t = classifyTask("grant permission to the service account");
      expect(t.taskClass).toBe("high_risk_review");
      expect(t.riskLevel).toBe("high");
    });

    it('detects "access control"', () => {
      const t = classifyTask("access control for the endpoint");
      expect(t.taskClass).toBe("high_risk_review");
      expect(t.riskLevel).toBe("high");
    });

    it('detects "keychain"', () => {
      const t = classifyTask("the keychain entry");
      expect(t.taskClass).toBe("high_risk_review");
      expect(t.riskLevel).toBe("high");
    });

    it('detects "privacy"', () => {
      const t = classifyTask("user privacy data");
      expect(t.taskClass).toBe("high_risk_review");
      expect(t.riskLevel).toBe("high");
    });

    it('detects "token" (word-boundary, including hyphenated forms)', () => {
      const t = classifyTask("auth-token rotation schedule");
      expect(t.taskClass).toBe("high_risk_review");
      expect(t.riskLevel).toBe("high");
    });

    it('detects "token" as a standalone word', () => {
      const t = classifyTask("rotate the token");
      expect(t.taskClass).toBe("high_risk_review");
      expect(t.riskLevel).toBe("high");
    });

    it('does NOT false-positive on "tokenize" (word-boundary tradeoff)', () => {
      const t = classifyTask("tokenize the input string for the parser");
      expect(t.signals).not.toContain("risk:token");
    });

    it('does NOT false-positive on "secretary" (word-boundary tradeoff)', () => {
      const t = classifyTask("email the secretary about the schedule");
      expect(t.signals).not.toContain("risk:secret");
    });

    it("every mandated keyword from the packet is present in the dictionary", () => {
      const mandated = [
        "authentication",
        "authorization",
        "access control",
        "permission",
        "security",
        "secret",
        "credential",
        "encryption",
        "payment",
        "billing",
        "production",
        "deployment",
        "rollback",
        "database migration",
        "schema migration",
        "data loss",
        "destructive",
        "concurrency",
        "public api",
        "compliance",
        "privacy",
        "keychain",
        "token",
      ];
      const lowerDict = HIGH_RISK_SIGNALS.map((s) => s.toLowerCase());
      for (const keyword of mandated) {
        expect(lowerDict).toContain(keyword);
      }
    });
  });

  describe("high risk overrides brevity and verb absence (§16.6 defect 2)", () => {
    // Each of these is a verified failure from the defect report: previously classified
    // as read_only (with riskLevel patched to "high" after the fact, an inconsistent
    // result), because none of them contain a review/change verb and all are under the
    // 40-character read-only catch-all threshold.
    const verifiedFailures = [
      "the payment failed",
      "rotate the secret",
      "production database is down",
      "billing looks wrong",
      "concurrency bug in the queue",
    ];

    for (const text of verifiedFailures) {
      it(`"${text}" classifies as high_risk_review`, () => {
        const t = classifyTask(text);
        expect(t.taskClass).toBe("high_risk_review");
        expect(t.riskLevel).toBe("high");
      });
    }

    it("still classifies high-risk with a review verb present (regression guard)", () => {
      const t = classifyTask("Review auth permissions");
      expect(t.taskClass).toBe("high_risk_review");
    });
  });

  describe("invariant: high risk never coexists with read_only", () => {
    it("holds across a broad generated set of inputs", () => {
      const subjects = [
        "the login page",
        "the payment flow",
        "the CI pipeline",
        "the config loader",
        "the auth token",
        "the database schema",
        "the keychain item",
        "the billing report",
        "the routing table",
        "the deployment script",
      ];
      const verbs = [
        "explain",
        "fix",
        "review",
        "list",
        "rotate",
        "describe",
        "implement",
        "",
        "check",
        "update",
      ];
      const riskWords = [
        "",
        "secret",
        "credential",
        "encryption",
        "production",
        "rollback",
        "compliance",
        "destructive",
        "keychain",
        "privacy",
      ];

      let combinations = 0;
      for (const subject of subjects) {
        for (const verb of verbs) {
          for (const risk of riskWords) {
            const text = [verb, subject, risk].filter(Boolean).join(" ");
            const result = classifyTask(text);
            combinations += 1;
            const violatesInvariant =
              result.riskLevel === "high" && result.taskClass === "read_only";
            expect(violatesInvariant).toBe(false);
          }
        }
      }
      expect(combinations).toBeGreaterThan(50);
    });

    it("throws if the invariant were somehow violated (documents the hard assertion)", () => {
      // classifyTask itself enforces this invariant with a thrown error as a defensive
      // backstop (see src/classifier/deterministic.ts). This test just documents that no
      // known input can reach that throw, by confirming a representative high-risk,
      // short, verb-less prompt classifies correctly rather than throwing.
      expect(() => classifyTask("secret")).not.toThrow();
      expect(classifyTask("secret").taskClass).toBe("high_risk_review");
    });
  });

  describe("determinism", () => {
    it("returns identical output across repeated calls for a variety of inputs", () => {
      const inputs = [
        "the payment failed",
        "Explain how the routing logic works in this repo",
        "grant permission to the service account",
        "Multi-file refactor across services for failing CI race condition",
        "!cheap rotate the token",
      ];
      for (const text of inputs) {
        const first = classifyTask(text);
        for (let i = 0; i < 5; i++) {
          expect(classifyTask(text)).toEqual(first);
        }
      }
    });
  });

  describe("negative controls: benign read-only prompts", () => {
    const benignPrompts = [
      "list the files in this repo",
      "explain how routing works",
      "what is the current model config",
      "show me the recent commits",
      "describe the folder structure",
    ];

    for (const text of benignPrompts) {
      it(`"${text}" still classifies read_only`, () => {
        const t = classifyTask(text);
        expect(t.taskClass).toBe("read_only");
        expect(t.riskLevel).toBe("low");
      });
    }
  });
});
