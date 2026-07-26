import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRouteDecisionEvent,
  buildRouteFailureEvent,
  buildUsageEvent,
  extractUsageFromEvent,
  recordEvent,
} from "../../src/integrations/commandcode-mod/telemetry.js";
import { readTelemetryEvents } from "../../src/telemetry/store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("mod telemetry", () => {
  it("records observed usage without inventing tokens", () => {
    const usage = extractUsageFromEvent({
      model: "deepseek/deepseek-v4-flash",
      usage: { inputTokens: 10, outputTokens: 4 },
      stopReason: "end_turn",
    });
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(4);
    expect(usage.labels?.inputTokens).toBe("OBSERVED");
    const absent = extractUsageFromEvent({ model: "x" });
    expect(absent.inputTokens).toBeUndefined();
    expect(absent.labels?.inputTokens).toBe("UNKNOWN");
  });

  it("does not store full prompts", () => {
    const ev = buildUsageEvent("run-1", {
      modelId: "m",
      inputTokens: 1,
    });
    expect(ev.meta?.promptStored).toBe(false);
    expect(JSON.stringify(ev)).not.toMatch(/implement the entire/);
  });

  it("append-only write and route-decision correlation", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-mod-tel-"));
    dirs.push(dir);
    const path = join(dir, "telemetry.jsonl");
    const decision = buildRouteDecisionEvent("run-1", "dec-abc", "model/a", {
      latencyMs: 20,
    });
    const usage = buildUsageEvent("run-1", {
      modelId: "model/a",
      routeDecisionId: "dec-abc",
      inputTokens: 3,
    });
    const failure = buildRouteFailureEvent("run-1", "timeout", "slow");
    recordEvent({ path, enabled: true }, decision);
    recordEvent({ path, enabled: true }, usage);
    recordEvent({ path, enabled: true }, failure);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    const events = readTelemetryEvents(path);
    expect(events).toHaveLength(3);
    expect(events[0]?.event).toBe("mod.route_decision");
    expect(events[1]?.meta?.routeDecisionId).toBe("dec-abc");
    expect(events[2]?.event).toBe("mod.route_failure");
  });

  it("skips write when disabled", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-mod-tel-"));
    dirs.push(dir);
    const path = join(dir, "telemetry.jsonl");
    recordEvent({ path, enabled: false }, buildRouteFailureEvent("r", "unknown", "x"));
    expect(() => readFileSync(path, "utf8")).toThrow();
  });
});
