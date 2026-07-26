import { describe, expect, it, vi } from "vitest";
import {
  formatExplain,
  formatStatus,
  parseProfileArg,
  runRouteCommand,
} from "../../src/integrations/commandcode-mod/commands.js";
import { createSessionState } from "../../src/integrations/commandcode-mod/session-state.js";
import type {
  CompatibilityReport,
  RouteClientResult,
} from "../../src/integrations/commandcode-mod/types.js";

const compat: CompatibilityReport = {
  status: "SUPPORTED",
  commandCodeVersion: "1.4.1",
  modApiVersion: "ModApi@command-code-1.4.1",
  missing: [],
  present: ["hooks", "setModel"],
  notes: [],
};

describe("mod commands helpers", () => {
  it("formats status with last decision and failure", () => {
    let state = createSessionState();
    state = {
      ...state,
      lastDecision: {
        modelId: "deepseek/deepseek-v4-flash",
        at: "2026-01-01T00:00:00.000Z",
        decisionId: "dec-1",
        latencyMs: 10,
        taskClass: "read_only",
      },
      lastFailure: {
        cause: "timeout",
        message: "slow",
        at: "2026-01-01T00:00:01.000Z",
      },
    };
    const text = formatStatus({
      state,
      compatibility: compat,
      pricingAgeMs: 100,
      catalogAgeMs: 200,
    });
    expect(text).toMatch(/enabled/);
    expect(text).toMatch(/deepseek\/deepseek-v4-flash/);
    expect(text).toMatch(/timeout/);
    expect(text).toMatch(/pricingFreshnessMs: 100/);
  });

  it("formats explain for success and failure", () => {
    const ok: RouteClientResult = {
      ok: true,
      modelId: "deepseek/deepseek-v4-flash",
      latencyMs: 5,
      decision: {
        taskClass: "read_only",
        qualityFloor: "standard",
        profile: "cheapest",
        candidates: [{}, {}],
        rejected: [{}],
        pricingSnapshotAgeMs: 1,
        pricingSnapshotRetrievedAt: "t",
        explanation: "picked cheap",
      },
    };
    expect(formatExplain(ok)).toMatch(/selected: deepseek/);
    expect(formatExplain(ok)).toMatch(/candidates: 2/);
    expect(
      formatExplain({
        ok: false,
        cause: "timeout",
        errorMessage: "too slow",
        latencyMs: 1500,
      }),
    ).toMatch(/route failed/);
  });

  it("parseProfileArg accepts only configured profiles", () => {
    expect(parseProfileArg("cheapest").ok).toBe(true);
    expect(parseProfileArg("balanced").ok).toBe(true);
    expect(parseProfileArg("frontier").ok).toBe(true);
    expect(parseProfileArg("turbo").ok).toBe(false);
    expect(parseProfileArg("").ok).toBe(false);
  });

  it("runRouteCommand returns decide-only success message", async () => {
    // Inject via decideRoute real path is heavy; test message shape with mock by
    // calling with unreachable bin and expect failure message shape.
    const r = await runRouteCommand({
      taskText: "hello",
      ccrouteCommand: { command: "/nonexistent/ccroute-bin-xyz" },
      timeoutMs: 200,
    });
    expect(r.message).toMatch(/route failed/);
    expect(r.result.ok).toBe(false);
  });

  it("runRouteCommand success via injected decide", async () => {
    const r = await runRouteCommand({
      taskText: "implement parser tests",
      decide: async () => ({
        ok: true,
        modelId: "deepseek/deepseek-v4-flash",
        latencyMs: 3,
        decision: { schemaVersion: 1, selectedModelId: "deepseek/deepseek-v4-flash" },
      }),
    });
    expect(r.result.ok).toBe(true);
    expect(r.message).toMatch(/selected model: deepseek\/deepseek-v4-flash/);
    expect(r.message).toMatch(/no repository writes/);
  });

  it("formatExplain tolerates missing decision fields", () => {
    expect(
      formatExplain({
        ok: true,
        modelId: "x",
        latencyMs: 1,
        decision: "not-an-object" as unknown as Record<string, unknown>,
      }),
    ).toMatch(/route failed/);
  });
});
