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
  const commands = new Map<
    string,
    (args: ModCommandHandlerArgs) => ModCommandResult | Promise<ModCommandResult>
  >();
  const events = new Map<string, (e: Record<string, unknown>) => void>();
  const api: ModApi = {
    name: "ccroute",
    cwd: process.cwd(),
    hooks: (h) => {
      hooks = { ...hooks, ...h };
      return { dispose() {} };
    },
    addCommand: (c) => {
      commands.set(c.name, c.handler);
      return { dispose() {} };
    },
    on: (event, handler) => {
      events.set(event, handler);
      return { dispose() {} };
    },
    setModel: vi.fn(),
    setEffort: vi.fn(),
    ui: { notify: vi.fn() },
  };
  return { api, hooks: () => hooks, commands, events };
}

describe("mod factory commands + events", () => {
  it("implements /router-on /router-off /router-profile /router-status", async () => {
    const { api, commands } = mockApi();
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide: async () => ({
        ok: true,
        modelId: "deepseek/deepseek-v4-flash",
        latencyMs: 1,
        decision: { schemaVersion: 1, selectedModelId: "deepseek/deepseek-v4-flash" },
      }),
    })(api);

    expect((await commands.get("router-off")!({ args: "" })).message).toMatch(/disabled/);
    expect((await commands.get("router-on")!({ args: "" })).message).toMatch(/enabled/);
    expect((await commands.get("router-profile")!({ args: "balanced" })).message).toMatch(
      /balanced/,
    );
    expect((await commands.get("router-profile")!({ args: "nope" })).message).toMatch(/unknown/);
    expect((await commands.get("router-status")!({ args: "" })).message).toMatch(/ccroute Mod/);
  });

  it("implements /route and /route-explain", async () => {
    const { api, commands } = mockApi();
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide: async () => ({
        ok: true,
        modelId: "deepseek/deepseek-v4-flash",
        latencyMs: 2,
        decision: {
          schemaVersion: 1,
          selectedModelId: "deepseek/deepseek-v4-flash",
          taskClass: "read_only",
          qualityFloor: "standard",
          profile: "cheapest",
          candidates: [],
          rejected: [],
          explanation: "ok",
        },
      }),
    })(api);

    expect((await commands.get("route")!({ args: "" })).message).toMatch(/usage/);
    expect((await commands.get("route")!({ args: "summarize file" })).message).toMatch(
      /selected model/,
    );
    expect((await commands.get("route-explain")!({ args: "" })).message).toMatch(/usage/);
    expect((await commands.get("route-explain")!({ args: "summarize file" })).message).toMatch(
      /selected:/,
    );
  });

  it("records model_request events and transform strips markers", async () => {
    const { api, hooks, events } = mockApi();
    createCcrouteMod({
      commandCodeVersion: "1.4.1",
      telemetryEnabled: false,
      decide: async () => ({
        ok: true,
        modelId: "deepseek/deepseek-v4-flash",
        latencyMs: 1,
        decision: { schemaVersion: 1, selectedModelId: "deepseek/deepseek-v4-flash" },
      }),
    })(api);

    events.get("model_request_start")?.({});
    events.get("model_request_end")?.({
      model: "deepseek/deepseek-v4-flash",
      usage: { inputTokens: 2, outputTokens: 1 },
      stopReason: "end_turn",
    });

    const t = await hooks().transformInput?.({ text: "!cheap fix typo in docs" });
    expect(t && "action" in t && t.action === "transform" ? t.text : "").toBe("fix typo in docs");
  });

  it("transform continues when compatibility unsupported", async () => {
    const { api, hooks } = mockApi();
    const broken = {
      ...api,
      setModel: undefined as unknown as ModApi["setModel"],
    };
    createCcrouteMod({ commandCodeVersion: "1.0.0", telemetryEnabled: false })(broken);
    const t = await hooks().transformInput?.({ text: "hello" });
    expect(t?.action === "continue" || t === undefined).toBe(true);
  });
});
