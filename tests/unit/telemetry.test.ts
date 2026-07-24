import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateByModel, formatStats } from "../../src/telemetry/aggregate.js";
import { appendTelemetry, readTelemetryEvents } from "../../src/telemetry/store.js";

describe("telemetry", () => {
  let dir: string;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-tel-"));
    process.env.HOME = dir;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends and aggregates", () => {
    const path = join(dir, "t.jsonl");
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      runId: "r1",
      event: "run_start",
      modelId: "m1",
      taskClass: "read_only",
    });
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      runId: "r1",
      event: "run_end",
      modelId: "m1",
      success: true,
      latencyMs: 100,
      estimatedCostUsd: 0.01,
      taskClass: "read_only",
    });
    const events = readTelemetryEvents(path);
    expect(events.length).toBe(2);
    const by = aggregateByModel(events);
    expect(by.get("m1")?.successfulRuns).toBe(1);
    expect(formatStats(by)).toContain("m1");
    expect(formatStats(by, { modelId: "missing" })).toContain("No telemetry");
    expect(formatStats(by, { taskClass: "read_only" }, events)).toContain("m1");
  });
});
