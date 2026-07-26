import { describe, expect, it, vi } from "vitest";
import { createCcrouteMod } from "../../src/integrations/commandcode-mod/index.js";
import type {
  ModApi,
  ModCommandHandlerArgs,
  ModCommandResult,
  ModHooks,
} from "../../src/integrations/commandcode-mod/types.js";

function mockApi() {
  let hooks: ModHooks = {};
  const commands: Array<{
    name: string;
    handler: (args: ModCommandHandlerArgs) => ModCommandResult | Promise<ModCommandResult>;
  }> = [];
  const setModel = vi.fn();
  const notify = vi.fn();
  const api: ModApi = {
    name: "ccroute",
    cwd: process.cwd(),
    hooks: (h) => {
      hooks = { ...hooks, ...h };
      return { dispose() {} };
    },
    addCommand: (c) => {
      commands.push(c);
      return { dispose() {} };
    },
    on: () => ({ dispose() {} }),
    setModel,
    setEffort: vi.fn(),
    ui: { notify },
  };
  return { api, getHooks: () => hooks, commands, setModel, notify };
}

describe("mod factory", () => {
  it("registers commands and routes via transformInput without model classifier", async () => {
    const { api, getHooks, commands, setModel } = mockApi();
    const decide = vi.fn(async () => ({
      ok: true as const,
      modelId: "deepseek/deepseek-v4-flash",
      latencyMs: 8,
      decision: {
        schemaVersion: 1 as const,
        selectedModelId: "deepseek/deepseek-v4-flash",
        taskClass: "standard_build",
        profile: "cheapest",
      },
    }));
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide,
    })(api);

    expect(commands.map((c) => c.name).sort()).toEqual(
      [
        "route",
        "route-explain",
        "router-off",
        "router-on",
        "router-profile",
        "router-status",
      ].sort(),
    );

    const result = await getHooks().transformInput?.({
      text: "implement a small helper",
    });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(setModel).toHaveBeenCalledWith("deepseek/deepseek-v4-flash");
    // Original prompt has no markers → continue
    expect(
      result?.action === "continue" || result === undefined || result?.action === "transform",
    ).toBe(true);
  });

  it("blocks child ccroute tool calls", async () => {
    const { api, getHooks } = mockApi();
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      env: { CCROUTE_CHILD: "1" } as NodeJS.ProcessEnv,
      decide: async () => ({ ok: false, latencyMs: 0, cause: "unknown" }),
    })(api);
    const blocked = await getHooks().beforeToolCall?.({
      toolName: "shell_command",
      input: { command: "ccroute orchestrate x" },
    });
    expect(blocked?.block).toBe(true);
  });

  it("degrades when API missing setModel", () => {
    const { api, getHooks, notify } = mockApi();
    // remove setModel
    const broken = { ...api, setModel: undefined as unknown as ModApi["setModel"] };
    createCcrouteMod({ commandCodeVersion: "1.4.1", telemetryEnabled: false })(broken);
    // transformInput may still register but routingLive false → continue
    expect(notify).toHaveBeenCalled();
    expect(getHooks().transformInput).toBeTypeOf("function");
  });

  it("strips removable markers via transform action", async () => {
    const { api, getHooks, setModel } = mockApi();
    const decide = vi.fn(async () => ({
      ok: true as const,
      modelId: "deepseek/deepseek-v4-flash",
      latencyMs: 4,
      decision: {
        schemaVersion: 1 as const,
        selectedModelId: "deepseek/deepseek-v4-flash",
        taskClass: "standard_build",
      },
    }));
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide,
    })(api);
    const result = await getHooks().transformInput?.({
      text: "!cheap implement a helper",
    });
    expect(setModel).toHaveBeenCalled();
    expect(result).toEqual({ action: "transform", text: "implement a helper" });
  });

  it("failed auto route keeps prompt (failed_open → continue/transform)", async () => {
    const { api, getHooks, setModel } = mockApi();
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide: async () => ({
        ok: false,
        latencyMs: 2,
        cause: "timeout" as const,
        errorMessage: "slow",
      }),
    })(api);
    const result = await getHooks().transformInput?.({ text: "ordinary prompt" });
    expect(setModel).not.toHaveBeenCalled();
    expect(result?.action === "continue" || result?.action === "transform").toBe(true);
  });

  it("records model_request events when on() is available", () => {
    const handlers = new Map<string, (e: Record<string, unknown>) => void>();
    const { api } = mockApi();
    api.on = (event, handler) => {
      handlers.set(event, handler);
      return { dispose() {} };
    };
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide: async () => ({ ok: false, latencyMs: 0, cause: "unknown" }),
    })(api);
    expect(handlers.has("model_request_start")).toBe(true);
    expect(handlers.has("model_request_end")).toBe(true);
    handlers.get("model_request_start")?.({});
    handlers.get("model_request_end")?.({
      model: "deepseek/deepseek-v4-flash",
      usage: { inputTokens: 10, outputTokens: 2 },
      stopReason: "end",
    });
  });
});
