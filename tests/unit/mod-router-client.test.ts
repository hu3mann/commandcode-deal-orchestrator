import { describe, expect, it } from "vitest";
import {
  decideRoute,
  validateDecidePayload,
} from "../../src/integrations/commandcode-mod/router-client.js";

const valid = JSON.stringify({
  task: { taskClass: "read_only" },
  decision: {
    schemaVersion: 1,
    selectedModelId: "deepseek/deepseek-v4-flash",
    taskClass: "read_only",
    profile: "cheapest",
    qualityFloor: "standard",
    candidates: [],
    rejected: [],
    tieBreakRule: "lowest_cost",
    dealAffectedSelection: false,
    pricingSnapshotAgeMs: 0,
    pricingSnapshotRetrievedAt: new Date().toISOString(),
    overridesApplied: [],
    explanation: "ok",
  },
});

describe("mod router-client validation", () => {
  it("accepts selected ID present in live catalog", () => {
    const live = new Set(["deepseek/deepseek-v4-flash"]);
    const r = validateDecidePayload(valid, live);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.decision.selectedModelId).toBe("deepseek/deepseek-v4-flash");
  });

  it("accepts when live catalog is empty or null (no post-filter)", () => {
    expect(validateDecidePayload(valid, null).ok).toBe(true);
    expect(validateDecidePayload(valid, new Set()).ok).toBe(true);
  });

  it("rejects selected ID absent from live catalog", () => {
    const live = new Set(["other/model"]);
    const r = validateDecidePayload(valid, live);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe("inventory");
  });

  it("rejects malformed JSON", () => {
    const r = validateDecidePayload("{not json", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.cause).toBe("malformed_json");
  });

  it("rejects schema-invalid payload (invented shape)", () => {
    const r = validateDecidePayload(JSON.stringify({ decision: { selectedModelId: "x" } }), null);
    expect(r.ok).toBe(false);
  });

  it("decideRoute success path parses stdout JSON", async () => {
    const result = await decideRoute({
      taskText: "hello",
      timeoutMs: 1500,
      liveModelIds: new Set(["deepseek/deepseek-v4-flash"]),
      ccrouteCommand: {
        command: process.execPath,
        prefixArgs: ["-e", `process.stdout.write(${JSON.stringify(valid)})`],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.modelId).toBe("deepseek/deepseek-v4-flash");
  });

  it("decideRoute rejects valid exit with model not in live catalog", async () => {
    const result = await decideRoute({
      taskText: "hello",
      timeoutMs: 1500,
      liveModelIds: new Set(["only/other"]),
      ccrouteCommand: {
        command: process.execPath,
        prefixArgs: ["-e", `process.stdout.write(${JSON.stringify(valid)})`],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("inventory");
  });

  it("classifies inventory / pricing / override / malformed exit messages", async () => {
    const cases: Array<{ msg: string; cause: string }> = [
      { msg: "unknown model not in live catalog", cause: "inventory" },
      { msg: "pricing snapshot expired deal", cause: "pricing" },
      { msg: "explicit model override unavailable", cause: "unavailable_override" },
      { msg: "malformed json payload", cause: "malformed_json" },
    ];
    for (const c of cases) {
      const result = await decideRoute({
        taskText: "x",
        timeoutMs: 1500,
        ccrouteCommand: {
          command: process.execPath,
          prefixArgs: ["-e", `console.error(${JSON.stringify(c.msg)}); process.exit(2)`],
        },
      });
      expect(result.ok).toBe(false);
      expect(result.cause).toBe(c.cause);
    }
  });

  it("decideRoute with profile and model flags still fails closed on bad bin", async () => {
    const result = await decideRoute({
      taskText: "task",
      profile: "cheapest",
      model: "deepseek/deepseek-v4-flash",
      timeoutMs: 300,
      ccrouteCommand: { command: "/no/such/ccroute-bin" },
    });
    expect(result.ok).toBe(false);
    expect(result.cause).toBe("spawn");
  });
});
