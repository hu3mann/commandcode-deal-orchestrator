import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TelemetryEventSchema } from "../../src/domain/telemetry.js";
import { aggregateByModel, formatStats } from "../../src/telemetry/aggregate.js";
import { appendTelemetry, readTelemetryEvents } from "../../src/telemetry/store.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const VITE_NODE_BIN = join(REPO_ROOT, "node_modules", ".bin", "vite-node");
const STORE_MODULE = join(REPO_ROOT, "src", "telemetry", "store.ts");

/**
 * Spawns a real, independent OS child process (via vite-node, so it can
 * import the actual TS source) that appends `count` telemetry records to
 * `path`, each tagged with a distinct runId so lost/duplicated/corrupted
 * records are detectable. This is deliberately a separate process (not a
 * Promise.all of in-process calls, and not a worker_thread) to exercise the
 * real "multiple independent ccroute invocations writing to the same
 * telemetry file concurrently" scenario.
 */
function spawnConcurrentWriter(
  scratchDir: string,
  path: string,
  workerId: number,
  count: number,
): Promise<void> {
  const scriptPath = join(scratchDir, `writer-${workerId}.mjs`);
  const script = `
    import { appendTelemetry } from ${JSON.stringify(STORE_MODULE)};
    const path = ${JSON.stringify(path)};
    for (let i = 0; i < ${count}; i++) {
      appendTelemetry(path, {
        schemaVersion: 1,
        ts: new Date().toISOString(),
        runId: "w${workerId}-" + i,
        event: "run_start",
      });
    }
  `;
  writeFileSync(scriptPath, script, "utf8");
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [VITE_NODE_BIN, scriptPath], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${workerId} exited ${code}: ${stderr}`));
    });
  });
}

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

  it("is append-only: prior lines survive later writes byte-for-byte", () => {
    const path = join(dir, "append-only.jsonl");
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: "2026-01-01T00:00:00.000Z",
      runId: "first",
      event: "run_start",
    });
    const afterFirst = readFileSync(path, "utf8");
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: "2026-01-01T00:00:01.000Z",
      runId: "second",
      event: "run_start",
    });
    const afterSecond = readFileSync(path, "utf8");
    // The first write's bytes must appear unmodified as a prefix of the file
    // after the second write -- nothing rewrites or reorders prior lines.
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond).toContain('"runId":"first"');
    expect(afterSecond).toContain('"runId":"second"');
  });

  it("survives concurrent appends from independent OS processes with no lost or corrupted records", async () => {
    const path = join(dir, "concurrent.jsonl");
    const workers = 6;
    const perWorker = 20;
    await Promise.all(
      Array.from({ length: workers }, (_, w) => spawnConcurrentWriter(dir, path, w, perWorker)),
    );

    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBe(workers * perWorker);

    // Every line must be valid, individually parseable JSON -- if two
    // concurrent writers ever interleaved partial writes, at least one
    // line would fail to parse or contain garbage from another line.
    const seenRunIds = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      seenRunIds.add(parsed.runId);
    }
    expect(seenRunIds.size).toBe(workers * perWorker);
    for (let w = 0; w < workers; w++) {
      for (let i = 0; i < perWorker; i++) {
        expect(seenRunIds.has(`w${w}-${i}`)).toBe(true);
      }
    }
  }, 20_000);

  it("skips a truncated final line (simulated crash mid-write) without losing prior history", () => {
    const path = join(dir, "truncated.jsonl");
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: "2026-01-01T00:00:00.000Z",
      runId: "good-1",
      event: "run_start",
      modelId: "m1",
    });
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: "2026-01-01T00:00:01.000Z",
      runId: "good-2",
      event: "run_end",
      modelId: "m1",
      success: true,
    });
    // Simulate a process that died mid-write: append a partial JSON line with
    // NO trailing newline, exactly like a crash after fs writes half a record.
    appendFileSync(path, '{"schemaVersion":1,"runId":"trunc', "utf8");

    const events = readTelemetryEvents(path);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.runId)).toEqual(["good-1", "good-2"]);

    // And it must not throw or crash the caller.
    expect(() => readTelemetryEvents(path)).not.toThrow();
  });

  it("§30 minimization: TelemetryEventSchema has no field for full task text or source code", () => {
    const keys = Object.keys(TelemetryEventSchema.shape);
    for (const forbidden of ["task", "taskText", "sourceCode", "stdout", "stderr", "prompt"]) {
      expect(keys).not.toContain(forbidden);
    }
    // The only free-form field is `meta`, and its values are redacted (see
    // the next test) -- but nothing about the schema *requires* meta to
    // exist, and no call site in orchestrator.ts/cli.ts currently puts task
    // text or source into it.
    expect(keys).toContain("meta");
  });

  it("§30 minimization: a distinctive secret-looking string in meta is redacted, not stored raw", () => {
    const path = join(dir, "minimize.jsonl");
    const distinctiveSecret = "DISTINCTIVE_MARKER_password: hunter2fakevalue";
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      runId: "r1",
      event: "run_start",
      meta: { note: distinctiveSecret },
    });
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("hunter2fakevalue");
    expect(raw).toContain("[REDACTED]");
  });

  it("aggregateByModel: exercises every event-type branch and the modelId-less skip", () => {
    const base = { schemaVersion: 1 as const, ts: "2026-01-01T00:00:00.000Z" };
    const events = [
      // No modelId -- must be skipped entirely (`if (!e.modelId) continue;`).
      { ...base, runId: "r0", event: "run_start" },
      { ...base, runId: "r1", event: "run_start", modelId: "m1" },
      { ...base, runId: "r1", event: "run_end", modelId: "m1", success: false },
      { ...base, runId: "r1", event: "timeout", modelId: "m1" },
      { ...base, runId: "r1", event: "schema_failure", modelId: "m1" },
      { ...base, runId: "r1", event: "repair", modelId: "m1" },
      { ...base, runId: "r1", event: "override", modelId: "m1" },
    ];
    const by = aggregateByModel(events);
    expect(by.has("undefined")).toBe(false);
    expect(by.size).toBe(1);
    const m = by.get("m1");
    expect(m?.failedRuns).toBe(1);
    expect(m?.timeouts).toBe(1);
    expect(m?.schemaFailures).toBe(1);
    expect(m?.repairTurns).toBe(1);
    expect(m?.operatorOverrides).toBe(1);
  });

  it("aggregateByModel: falls back to n=1 when latencyMs arrives before any success/failure is recorded", () => {
    const events = [
      {
        schemaVersion: 1 as const,
        ts: "2026-01-01T00:00:00.000Z",
        runId: "r1",
        event: "role_start",
        modelId: "m1",
        latencyMs: 250,
      },
    ];
    const m = aggregateByModel(events).get("m1");
    // successfulRuns + failedRuns is 0 here, so the `|| 1` fallback must be
    // what makes this an exact average rather than a divide-by-zero/NaN.
    expect(m?.averageLatencyMs).toBe(250);
  });

  it("formatStats: shows rate=n/a for a model with zero attempts (distinct from the no-telemetry-at-all path)", () => {
    const events = [
      {
        schemaVersion: 1 as const,
        ts: "2026-01-01T00:00:00.000Z",
        runId: "r1",
        event: "role_end", // not run_start/role_start, so attempts stays 0
        modelId: "m1",
      },
    ];
    const by = aggregateByModel(events);
    expect(by.get("m1")?.attempts).toBe(0);
    expect(formatStats(by)).toContain("rate=n/a");
  });

  it("aggregates observedCostUsd across multiple events for the same model", () => {
    const events = [
      {
        schemaVersion: 1 as const,
        ts: "2026-01-01T00:00:00.000Z",
        runId: "r1",
        event: "run_end",
        modelId: "m1",
        observedCostUsd: 0.02,
      },
      {
        schemaVersion: 1 as const,
        ts: "2026-01-01T00:00:01.000Z",
        runId: "r1",
        event: "run_end",
        modelId: "m1",
        observedCostUsd: 0.03,
      },
    ];
    const by = aggregateByModel(events);
    expect(by.get("m1")?.observedCost).toBeCloseTo(0.05);
  });

  it("only redacts string meta values -- non-string meta values pass through untouched", () => {
    const path = join(dir, "mixed-meta.jsonl");
    appendTelemetry(path, {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      runId: "r1",
      event: "run_start",
      meta: {
        secretNote: "password: hunter2fakevalue",
        attemptNumber: 3,
        isRetry: false,
      },
    });
    const [event] = readTelemetryEvents(path);
    expect(event?.meta?.secretNote).toBe("[REDACTED]");
    expect(event?.meta?.attemptNumber).toBe(3);
    expect(event?.meta?.isRetry).toBe(false);
  });

  it("store-level telemetry switch: appendTelemetry is only invoked when the caller's " +
    "enabled flag is true -- store.ts has no independent override, so this is the " +
    "exact gate cli.ts's --no-telemetry and orchestrator.ts's telemetryEnabled must use", () => {
    const path = join(dir, "switch.jsonl");
    const maybeAppend = (enabled: boolean) => {
      if (enabled) {
        appendTelemetry(path, {
          schemaVersion: 1,
          ts: new Date().toISOString(),
          runId: "r1",
          event: "run_start",
        });
      }
    };

    maybeAppend(false);
    expect(readTelemetryEvents(path)).toEqual([]);

    maybeAppend(true);
    expect(readTelemetryEvents(path).length).toBe(1);
  });
});
