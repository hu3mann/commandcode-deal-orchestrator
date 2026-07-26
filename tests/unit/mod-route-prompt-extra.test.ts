import { describe, expect, it, vi } from "vitest";
import {
  ModRouteError,
  formatRouteWarning,
} from "../../src/integrations/commandcode-mod/errors.js";
import { routeTypedPrompt } from "../../src/integrations/commandcode-mod/route-prompt.js";
import {
  createSessionState,
  recordFailure,
  recordSuccess,
} from "../../src/integrations/commandcode-mod/session-state.js";
import type { RouteClientResult } from "../../src/integrations/commandcode-mod/types.js";

const ok = (modelId = "deepseek/deepseek-v4-flash"): RouteClientResult => ({
  ok: true,
  modelId,
  effort: "medium",
  latencyMs: 9,
  decision: {
    schemaVersion: 1,
    selectedModelId: modelId,
    taskClass: "standard_build",
    profile: "balanced",
  },
});

describe("mod route-prompt extras", () => {
  it("applies effort when provided and setEffort exists", async () => {
    const setEffort = vi.fn();
    await routeTypedPrompt("build it", createSessionState(), {
      decide: async () => ok(),
      setModel: vi.fn(),
      setEffort,
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d1",
    });
    expect(setEffort).toHaveBeenCalledWith("medium");
  });

  it("handles setModel throw on auto route as failed_open", async () => {
    const out = await routeTypedPrompt("build it", createSessionState(), {
      decide: async () => ok(),
      setModel: () => {
        throw new Error("api gone");
      },
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d1",
    });
    expect(out.kind).toBe("failed_open");
  });

  it("handles setModel throw on explicit override as handled", async () => {
    const out = await routeTypedPrompt(
      "!model=deepseek/deepseek-v4-flash build it",
      createSessionState(),
      {
        decide: async () => ok(),
        setModel: () => {
          throw new Error("api gone");
        },
        warn: vi.fn(),
        onSuccess: vi.fn(),
        onFailure: vi.fn(),
        newDecisionId: () => "d1",
      },
    );
    expect(out.kind).toBe("handled");
  });

  it("allows !route-on when session routing is off", async () => {
    const state = { ...createSessionState(), routingEnabled: false };
    const decide = vi.fn(async () => ok());
    const out = await routeTypedPrompt("!route-on fix bug", state, {
      decide,
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d1",
    });
    expect(decide).toHaveBeenCalled();
    expect(out.kind).toBe("routed");
  });

  it("allows profile marker when session is off", async () => {
    const state = { ...createSessionState(), routingEnabled: false };
    const decide = vi.fn(async () => ok());
    await routeTypedPrompt("!cheap tidy comments", state, {
      decide,
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d1",
    });
    expect(decide).toHaveBeenCalled();
  });

  it("ignores setEffort throw", async () => {
    const out = await routeTypedPrompt("build it", createSessionState(), {
      decide: async () => ok(),
      setModel: vi.fn(),
      setEffort: () => {
        throw new Error("no effort");
      },
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d1",
    });
    expect(out.kind).toBe("routed");
  });

  it("session-state recordSuccess and recordFailure", () => {
    let s = createSessionState();
    s = recordSuccess(s, {
      modelId: "m",
      decisionId: "d",
      latencyMs: 1,
      taskClass: "read_only",
      profile: "cheapest",
    });
    expect(s.lastDecision?.modelId).toBe("m");
    expect(s.routeDecisions).toBe(1);
    s = recordFailure(s, "pricing", "stale");
    expect(s.lastFailure?.cause).toBe("pricing");
  });

  it("error helpers", () => {
    const e = new ModRouteError("boom", "timeout", "T");
    expect(e.code).toBe("T");
    expect(e.causeKind).toBe("timeout");
    expect(formatRouteWarning("inventory", "detail")).toMatch(/inventory/);
    expect(formatRouteWarning("pricing")).toMatch(/pricing/);
    expect(formatRouteWarning("spawn")).toMatch(/invoke/);
    expect(formatRouteWarning("malformed_json")).toMatch(/malformed/);
    expect(formatRouteWarning("compatibility")).toMatch(/compatibility/);
    expect(formatRouteWarning("no_eligible_route")).toMatch(/eligible/);
    expect(formatRouteWarning("unknown")).toMatch(/failed/);
  });
});
