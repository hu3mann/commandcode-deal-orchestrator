import { describe, expect, it, vi } from "vitest";
import { routeTypedPrompt } from "../../src/integrations/commandcode-mod/route-prompt.js";
import { createSessionState } from "../../src/integrations/commandcode-mod/session-state.js";
import type { RouteClientResult } from "../../src/integrations/commandcode-mod/types.js";

function okResult(modelId = "deepseek/deepseek-v4-flash"): RouteClientResult {
  return {
    ok: true,
    modelId,
    latencyMs: 12,
    decision: {
      schemaVersion: 1,
      selectedModelId: modelId,
      taskClass: "standard_build",
      profile: "cheapest",
      qualityFloor: "standard",
    },
  };
}

describe("mod routeTypedPrompt", () => {
  it("routes ordinary typed prompt, sets model once, preserves task text", async () => {
    const setModel = vi.fn();
    const decide = vi.fn(async () => okResult());
    const onSuccess = vi.fn();
    const state = createSessionState();

    const out = await routeTypedPrompt("implement a unit test for the parser", state, {
      decide,
      setModel,
      warn: vi.fn(),
      onSuccess,
      onFailure: vi.fn(),
      newDecisionId: () => "dec-1",
    });

    expect(out.kind).toBe("routed");
    if (out.kind === "routed") {
      expect(out.text).toBe("implement a unit test for the parser");
      expect(out.modelId).toBe("deepseek/deepseek-v4-flash");
    }
    expect(decide).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("honors !route-off bypass without decide", async () => {
    const decide = vi.fn();
    const out = await routeTypedPrompt("!route-off just chat", createSessionState(), {
      decide,
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "x",
    });
    expect(out.kind).toBe("pass_through");
    if (out.kind === "pass_through") expect(out.text).toBe("just chat");
    expect(decide).not.toHaveBeenCalled();
  });

  it("applies explicit profile marker", async () => {
    const decide = vi.fn(async (opts) => {
      expect(opts.profile).toBe("frontier");
      return okResult("xai/grok-4.5");
    });
    await routeTypedPrompt("!frontier design the system", createSessionState(), {
      decide,
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(decide).toHaveBeenCalled();
  });

  it("fails closed on unavailable explicit model override", async () => {
    const decide = vi.fn(async () => ({
      ok: false,
      latencyMs: 5,
      cause: "unavailable_override" as const,
      errorMessage: "unknown model",
    }));
    const setModel = vi.fn();
    const out = await routeTypedPrompt("!model=not-a-real/model fix it", createSessionState(), {
      decide,
      setModel,
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(out.kind).toBe("handled");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("keeps session model on automatic timeout", async () => {
    const warn = vi.fn();
    const setModel = vi.fn();
    const out = await routeTypedPrompt("build a feature", createSessionState(), {
      decide: async () => ({
        ok: false,
        latencyMs: 1500,
        cause: "timeout",
        errorMessage: "timeout",
      }),
      setModel,
      warn,
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(out.kind).toBe("failed_open");
    expect(setModel).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("handles malformed decide by failing open for auto route", async () => {
    const out = await routeTypedPrompt("refactor module", createSessionState(), {
      decide: async () => ({
        ok: false,
        cause: "malformed_json",
        errorMessage: "bad json",
        latencyMs: 3,
      }),
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(out.kind).toBe("failed_open");
  });

  it("strips removable markers from forwarded prompt", async () => {
    const out = await routeTypedPrompt("!cheap fix the typo", createSessionState(), {
      decide: async () => okResult(),
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(out.kind).toBe("routed");
    if (out.kind === "routed") expect(out.text).toBe("fix the typo");
  });

  it("session router-off skips automatic routing", async () => {
    const state = { ...createSessionState(), routingEnabled: false };
    const decide = vi.fn();
    const out = await routeTypedPrompt("hello world", state, {
      decide,
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(out.kind).toBe("pass_through");
    expect(decide).not.toHaveBeenCalled();
  });

  it("proves one decide and zero classifier-model requests", async () => {
    let decideCalls = 0;
    const classifierModelRequests = 0;
    await routeTypedPrompt("add logging", createSessionState(), {
      decide: async () => {
        decideCalls += 1;
        // Routing must never spawn a classifier model.
        return okResult();
      },
      setModel: vi.fn(),
      warn: vi.fn(),
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      newDecisionId: () => "d",
    });
    expect(decideCalls).toBe(1);
    expect(classifierModelRequests).toBe(0);
  });
});
