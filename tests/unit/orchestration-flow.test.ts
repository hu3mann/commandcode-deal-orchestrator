import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import type { RoutingConfig } from "../../src/config/schemas.js";
import type { CandidateScore, RouteDecision } from "../../src/domain/route.js";
import type { ClassifiedTask } from "../../src/domain/task.js";
import { type OrchestrateOptions, orchestrate } from "../../src/orchestration/orchestrator.js";
import type { RoleName } from "../../src/orchestration/roles.js";
import type { SpawnCmdOptions, SpawnCmdResult } from "../../src/subprocess/commandcode.js";

/**
 * §34.7 end-to-end orchestration coverage: drives orchestrate() with an injected FAKE
 * role-runner (no real subprocess, no cost, no --network, no CCROUTE_LIVE). Every test
 * here also redirects HOME to a mkdtempSync dir, because orchestrate()'s terminal
 * finalize() step best-effort-copies the resolved pricing snapshot
 * (copyPricingSnapshotBestEffort -> pricingSnapshotPath() -> homedir()) into the run dir.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<ClassifiedTask> = {}): ClassifiedTask {
  return {
    originalText: "perform a complex multi-file build",
    cleanedText: "perform a complex multi-file build",
    taskClass: "complex_build",
    riskLevel: "low",
    signals: [],
    overrides: {},
    requiredCapabilities: [],
    ...overrides,
  };
}

function makeCandidate(modelId: string): CandidateScore {
  return {
    modelId,
    qualityTier: "capable",
    cost: {
      freshInputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 100,
      cacheWriteTokens: 0,
      freshInputCost: 0.01,
      cachedInputCost: 0,
      outputCost: 0.01,
      cacheWriteCost: 0,
      estimatedRequestCost: 0.02,
      expectedRetryCost: 0,
      expectedEscalationCost: 0,
      latencyPenalty: 0,
      expectedTotalCost: 0.02,
      priceBasis: "post_discount",
      dealApplied: false,
      estimateLabel: "estimate",
    },
    successRate: 0.99,
    averageLatencyMs: 1000,
    score: 1,
    preferred: true,
  };
}

function makeDecision(candidateIds: string[]): RouteDecision {
  return {
    schemaVersion: 1,
    taskClass: "complex_build",
    profile: "balanced",
    selectedModelId: candidateIds[0] ?? "model-a",
    qualityFloor: "capable",
    candidates: candidateIds.map(makeCandidate),
    rejected: [],
    tieBreakRule: "lowest-expected-cost",
    dealAffectedSelection: false,
    pricingSnapshotAgeMs: 0,
    pricingSnapshotRetrievedAt: new Date().toISOString(),
    overridesApplied: [],
    explanation: "test fixture decision",
  };
}

function envelope(role: RoleName, fields: Record<string, unknown> = {}): string {
  const body = {
    schemaVersion: 1,
    role,
    status: "success",
    summary: `${role} ok`,
    artifacts: [],
    findings: [],
    ...fields,
  };
  return `BEGIN_CCROUTE_RESULT\n${JSON.stringify(body)}\nEND_CCROUTE_RESULT`;
}

interface CapturedCall {
  role?: string;
  model: string;
  stdinText: string;
  autoAccept?: boolean;
  plan?: boolean;
}

/**
 * Fake role-runner: for each role, a queue of stdout strings is consumed in order (the
 * last entry repeats once exhausted). Every call is recorded for assertions. This is the
 * injection seam (`opts.spawnImpl`) that lets orchestrate() be driven end to end with
 * zero real subprocesses and zero LLM cost.
 */
function makeFakeRoleRunner(queues: Partial<Record<RoleName, string[]>>) {
  const calls: CapturedCall[] = [];
  const cursors: Partial<Record<RoleName, number>> = {};
  const spawnImpl = async (opts: SpawnCmdOptions): Promise<SpawnCmdResult> => {
    calls.push({
      role: opts.role,
      model: opts.model,
      stdinText: opts.stdinText,
      autoAccept: opts.autoAccept,
      plan: opts.plan,
    });
    const role = (opts.role ?? "executor") as RoleName;
    const q = queues[role] ?? [envelope(role)];
    const idx = cursors[role] ?? 0;
    cursors[role] = idx + 1;
    const stdout = q[idx] ?? q[q.length - 1] ?? envelope(role);
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: "",
      timedOut: false,
      argv: [],
      durationMs: 1,
    };
  };
  return { spawnImpl, calls };
}

/** Fake `node:child_process.spawn` for the deterministic validation gate, keyed by
 * "argv0 arg1 arg2 ...". Never spawns a real process. */
function makeFakeValidationSpawn(byCommand: Record<string, { code: number; out?: string }>) {
  return ((cmd: string, args: string[]) => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ChildProcess for tests
    (child as any).stdout = stdout;
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ChildProcess for tests
    (child as any).stderr = stderr;
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ChildProcess for tests
    (child as any).pid = 1234;
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake ChildProcess for tests
    (child as any).kill = () => true;
    const key = [cmd, ...args].join(" ");
    const cfg = byCommand[key] ?? { code: 0 };
    queueMicrotask(() => {
      if (cfg.out) stdout.emit("data", Buffer.from(cfg.out));
      child.emit("close", cfg.code);
    });
    return child;
    // biome-ignore lint/suspicious/noExplicitAny: cast to the node:child_process spawn signature
  }) as any;
}

const allPassValidationSpawn = makeFakeValidationSpawn({
  "npm run typecheck": { code: 0 },
  "npm run lint": { code: 0 },
  "npm test": { code: 0 },
  "npm run build": { code: 0 },
});

let config: RoutingConfig;
let homeDir: string;
let runsRoot: string;
let prevHome: string | undefined;

beforeEach(() => {
  config = loadDefaultRoutingConfig();
  prevHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "ccroute-orch-home-"));
  process.env.HOME = homeDir;
  runsRoot = mkdtempSync(join(tmpdir(), "ccroute-orch-runs-"));
});

afterEach(() => {
  process.env.HOME = prevHome;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(runsRoot, { recursive: true, force: true });
});

function baseOpts(partial: Partial<OrchestrateOptions>): OrchestrateOptions {
  return {
    cmdPath: "/fake/cmd",
    config,
    task: makeTask(),
    decision: makeDecision(["model-a"]),
    apply: false,
    runDir: join(runsRoot, "run"),
    models: {},
    flags: { skipValidation: true },
    ...partial,
  };
}

function manifestOf(runDir: string): { status: string; roles: string[]; blockedReason?: string } {
  return JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
}

describe("orchestrate() end-to-end (§34.7)", () => {
  it("1. planner only — advisor and reviewer disabled", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      planner: [envelope("planner", { artifacts: ["a bounded plan"] })],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        flags: { noAdvisor: true, noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.roles.planner).toBeDefined();
    expect(result.roles.advisor).toBeUndefined();
    expect(result.roles.reviewer).toBeUndefined();
    expect(result.roles.executor).toBeDefined();
    expect(calls.some((c) => c.role === "planner")).toBe(true);
    expect(calls.some((c) => c.role === "advisor")).toBe(false);
    expect(manifestOf(baseOpts({}).runDir).status).toBe("OK");
  });

  it("2. planner + advisor — advisor approves the plan on the first pass", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      planner: [envelope("planner", { artifacts: ["plan v1"] })],
      advisor: [envelope("advisor", { decision: "PLAN_APPROVED" })],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        decision: makeDecision(["model-a", "model-b"]),
        flags: { noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.roles.advisor?.decision).toBe("PLAN_APPROVED");
    const advisorCall = calls.find((c) => c.role === "advisor");
    expect(advisorCall?.model).toBe("model-b");
  });

  it("3. advisor independence — fails closed when no distinct model is available", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      planner: [envelope("planner", { artifacts: ["plan v1"] })],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        decision: makeDecision(["model-a"]), // only one candidate: no distinct alternate
        flags: { noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(7);
    expect(result.summary).toMatch(/independence/i);
    expect(result.roles.advisor).toBeUndefined();
    expect(calls.some((c) => c.role === "advisor")).toBe(false);
    expect(manifestOf(baseOpts({}).runDir).status).toBe("ADVISOR_INDEPENDENCE_BLOCKED");
  });

  it("4. one revision — advisor requests a revision, planner revises, advisor approves", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      planner: [
        envelope("planner", { artifacts: ["plan v1"] }),
        envelope("planner", { artifacts: ["plan v2 (revised)"] }),
      ],
      advisor: [
        envelope("advisor", { decision: "PLAN_REQUIRES_REVISION" }),
        envelope("advisor", { decision: "PLAN_APPROVED" }),
      ],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        decision: makeDecision(["model-a", "model-b"]),
        flags: { noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(calls.filter((c) => c.role === "planner")).toHaveLength(2);
    expect(calls.filter((c) => c.role === "advisor")).toHaveLength(2);
    expect(result.roles.advisor?.decision).toBe("PLAN_APPROVED");
  });

  it("5. revision limit — repeated PLAN_REQUIRES_REVISION exceeds maxPlannerRevisions", async () => {
    const { spawnImpl } = makeFakeRoleRunner({
      planner: [envelope("planner", { artifacts: ["plan"] })],
      advisor: [envelope("advisor", { decision: "PLAN_REQUIRES_REVISION" })],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        decision: makeDecision(["model-a", "model-b"]),
        flags: { noReviewer: true, skipValidation: true },
      }),
    );
    expect(config.orchestration.maxPlannerRevisions).toBe(1);
    expect(result.exitCode).toBe(3);
    expect(result.summary).toMatch(/revision limit/i);
    expect(manifestOf(baseOpts({}).runDir).status).toBe("PLANNER_REVISION_LIMIT");
  });

  it("6. executor read-only — apply:false means no write authorization is granted", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({});
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        apply: false,
        flags: { noPlanner: true, noAdvisor: true, noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    const executorCall = calls.find((c) => c.role === "executor");
    expect(executorCall?.autoAccept).toBe(false);
    expect(executorCall?.stdinText).toContain("Do not write files");
  });

  it("7. executor apply mode — apply:true grants write authorization", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({});
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        apply: true,
        flags: { noPlanner: true, noAdvisor: true, noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    const executorCall = calls.find((c) => c.role === "executor");
    expect(executorCall?.autoAccept).toBe(true);
    expect(executorCall?.stdinText).toContain("Writes authorized via --apply");
  });

  it("8. reviewer accept — full run succeeds and artifacts use the §31 filenames", async () => {
    const { spawnImpl } = makeFakeRoleRunner({
      reviewer: [envelope("reviewer", { decision: "ACCEPT" })],
    });
    const runDir = join(runsRoot, "reviewer-accept");
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        runDir,
        flags: { noPlanner: true, noAdvisor: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.roles.reviewer?.decision).toBe("ACCEPT");
    const files = readdirSync(runDir);
    expect(files).toContain("task-metadata.json");
    expect(files).toContain("review-result.json");
    expect(files).not.toContain("reviewer-result.json");
    expect(files).not.toContain("task.json");
    expect(files).toContain("tests.json");
    expect(files).toContain("manifest.json");
    expect(files).toContain("summary.md");
  });

  it("9. reviewer repair — REPAIR_REQUIRED runs repair, then the reviewer accepts", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      reviewer: [
        envelope("reviewer", { decision: "REPAIR_REQUIRED" }),
        envelope("reviewer", { decision: "ACCEPT" }),
      ],
      repair: [envelope("repair", {})],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        flags: { noPlanner: true, noAdvisor: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.roles.repair).toBeDefined();
    expect(calls.filter((c) => c.role === "reviewer")).toHaveLength(2);
    expect(calls.filter((c) => c.role === "repair")).toHaveLength(1);
  });

  it("10. repair limit — REPAIR_REQUIRED forever exceeds maxRepairs", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      reviewer: [envelope("reviewer", { decision: "REPAIR_REQUIRED" })],
      repair: [envelope("repair", {})],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        flags: { noPlanner: true, noAdvisor: true, skipValidation: true },
      }),
    );
    expect(config.orchestration.maxRepairs).toBe(1);
    expect(result.exitCode).toBe(4);
    expect(result.summary).toMatch(/repair limit/i);
    expect(calls.filter((c) => c.role === "repair")).toHaveLength(1);
    expect(manifestOf(baseOpts({}).runDir).status).toBe("REPAIR_LIMIT");
  });

  it("11. second format failure — invalid envelope on both attempts fails the role", async () => {
    const { spawnImpl } = makeFakeRoleRunner({
      planner: ["not an envelope, attempt one", "still not an envelope, attempt two"],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        flags: { noAdvisor: true, noReviewer: true, skipValidation: true },
      }),
    );
    expect(config.orchestration.maxFormatRepairs).toBe(1);
    expect(result.exitCode).toBe(2);
    expect(result.summary).toMatch(/validation failed twice/i);
    expect(manifestOf(baseOpts({}).runDir).status).toBe("PLANNER_FAILED");
  });

  it("12. fallback within quality floor — a distinct candidate is used, no block", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      planner: [envelope("planner", { artifacts: ["plan"] })],
      advisor: [envelope("advisor", { decision: "PLAN_APPROVED" })],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        // selectedModelId ("model-a") repeats as both planner+advisor default; a distinct
        // alternate ("model-b") exists among the routing candidates, all of which already
        // satisfy the task's quality floor by construction of the router's decision.
        decision: makeDecision(["model-a", "model-b", "model-c"]),
        flags: { noReviewer: true, skipValidation: true },
      }),
    );
    expect(result.exitCode).toBe(0);
    const advisorCall = calls.find((c) => c.role === "advisor");
    expect(advisorCall?.model).toBe("model-b");
    expect(advisorCall?.model).not.toBe("model-a");
  });

  // ---------------------------------------------------------------------
  // Bonus coverage: proves defects 1, 5, and 6 directly rather than by inference.
  // ---------------------------------------------------------------------

  it("defect 1 proof: deterministic validation gate blocks the run despite a Reviewer ACCEPT", async () => {
    const failingValidationSpawn = makeFakeValidationSpawn({
      "npm run typecheck": { code: 0 },
      "npm run lint": { code: 0 },
      "npm test": { code: 1, out: "1 failing test" },
      "npm run build": { code: 0 },
    });
    const { spawnImpl } = makeFakeRoleRunner({
      reviewer: [envelope("reviewer", { decision: "ACCEPT" })],
    });
    const runDir = join(runsRoot, "gate-blocks");
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        runDir,
        flags: { noPlanner: true, noAdvisor: true }, // skipValidation NOT set: gate runs
        validationSpawnImpl: failingValidationSpawn,
      }),
    );
    // The Reviewer said ACCEPT, but a failing deterministic gate is authoritative.
    expect(result.roles.reviewer?.decision).toBe("ACCEPT");
    expect(result.exitCode).toBe(6);
    expect(result.summary).toMatch(/cannot be overridden/i);
    expect(manifestOf(runDir).status).toBe("VALIDATION_FAILED");
    const gate = JSON.parse(readFileSync(join(runDir, "tests.json"), "utf8"));
    expect(gate.ran).toBe(true);
    expect(gate.passed).toBe(false);
  });

  it("defect 1 proof: a passing gate does not block a Reviewer ACCEPT", async () => {
    const { spawnImpl } = makeFakeRoleRunner({
      reviewer: [envelope("reviewer", { decision: "ACCEPT" })],
    });
    const result = await orchestrate(
      baseOpts({
        spawnImpl,
        flags: { noPlanner: true, noAdvisor: true },
        validationSpawnImpl: allPassValidationSpawn,
      }),
    );
    expect(result.exitCode).toBe(0);
  });

  it("defect 6 proof: the Reviewer packet carries a real diffSummary and testResults", async () => {
    const { spawnImpl, calls } = makeFakeRoleRunner({
      reviewer: [envelope("reviewer", { decision: "ACCEPT" })],
    });
    await orchestrate(
      baseOpts({
        spawnImpl,
        flags: { noPlanner: true, noAdvisor: true },
        validationSpawnImpl: allPassValidationSpawn,
      }),
    );
    const reviewerCall = calls.find((c) => c.role === "reviewer");
    expect(reviewerCall).toBeDefined();
    const match = reviewerCall?.stdinText.match(/```json\n([\s\S]*?)\n```/);
    expect(match).toBeTruthy();
    const packet = JSON.parse(match?.[1] ?? "{}");
    expect(packet.diffSummary).not.toBeNull();
    expect(typeof packet.diffSummary).toBe("string");
    expect(packet.testResults).toContain("Deterministic validation gate PASSED");
  });

  it("defect 5 proof: a failure path still writes manifest.json and summary.md", async () => {
    const { spawnImpl } = makeFakeRoleRunner({
      planner: ["garbage output", "still garbage"],
    });
    const runDir = join(runsRoot, "failure-writes-manifest");
    await orchestrate(
      baseOpts({
        spawnImpl,
        runDir,
        flags: { noAdvisor: true, noReviewer: true, skipValidation: true },
      }),
    );
    expect(existsSync(join(runDir, "manifest.json"))).toBe(true);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    const manifest = manifestOf(runDir);
    expect(manifest.status).toBe("PLANNER_FAILED");
  });
});
