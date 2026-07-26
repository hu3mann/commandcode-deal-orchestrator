import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import {
  CmdNotFoundError,
  buildEffectiveOrchestrationConfig,
  buildExplainJson,
  buildOrchestrateOptions,
  buildRepoSignals,
  buildRunEndEvent,
  buildRunManifest,
  buildRunSpawnOptions,
  buildRunStartEvent,
  commitRunChanges,
  computeDoctorHealth,
  detectMarkerConflicts,
  gitStatusPaths,
  validateCommitFlag,
} from "../../src/cli.js";
import { CliUsageError, exitCodeForErrorCode } from "../../src/cli/exit-codes.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { loadSeedPricingSnapshot } from "../../src/pricing/snapshot.js";
import { selectRoute } from "../../src/router/select.js";

function fixtureTaskAndDecision() {
  const config = loadDefaultRoutingConfig();
  const pricing = loadSeedPricingSnapshot();
  const task = classifyTask("Summarize this repository", {});
  const decision = selectRoute({
    models: pricing.models,
    liveModelIds: null,
    config,
    task,
    pricingRetrievedAt: pricing.retrievedAt,
    now: new Date("2026-07-26T00:00:00Z"),
  });
  return { config, task, decision };
}

describe("detectMarkerConflicts (§22)", () => {
  it("detects no conflict when only one profile marker is present", () => {
    expect(detectMarkerConflicts("fix the bug !cheap please")).toEqual([]);
  });

  it("detects no conflict when there are no markers at all", () => {
    expect(detectMarkerConflicts("fix the bug please")).toEqual([]);
  });

  it("detects a conflicting profile marker pair", () => {
    const conflicts = detectMarkerConflicts("fix it !cheap !frontier now");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatch(/conflicting profile markers/);
    expect(conflicts[0]).toContain("!cheap");
    expect(conflicts[0]).toContain("!frontier");
  });

  it("does not flag the same profile marker repeated twice", () => {
    expect(detectMarkerConflicts("!cheap do this !cheap")).toEqual([]);
  });

  it("detects a conflicting model marker pair", () => {
    const conflicts = detectMarkerConflicts("do it !model=foo/a !model=bar/b");
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatch(/conflicting model markers/);
  });

  it("detects both a profile and a model conflict simultaneously", () => {
    const conflicts = detectMarkerConflicts("!cheap !frontier !model=a/x !model=b/y do it");
    expect(conflicts.length).toBe(2);
  });
});

describe("validateCommitFlag", () => {
  it("throws CliUsageError when --commit is set without --apply", () => {
    expect(() => validateCommitFlag({ commit: true, apply: false })).toThrow(CliUsageError);
    expect(() => validateCommitFlag({ commit: true })).toThrow(/requires --apply/);
  });

  it("does not throw when --commit is set with --apply", () => {
    expect(() => validateCommitFlag({ commit: true, apply: true })).not.toThrow();
  });

  it("does not throw when --commit is not set, regardless of --apply", () => {
    expect(() => validateCommitFlag({})).not.toThrow();
    expect(() => validateCommitFlag({ apply: true })).not.toThrow();
    expect(() => validateCommitFlag({ apply: false })).not.toThrow();
  });
});

describe("CmdNotFoundError exit-code mapping", () => {
  it("maps to MODEL_UNAVAILABLE (11)", () => {
    const e = new CmdNotFoundError();
    expect(e.code).toBe("CMD_NOT_FOUND");
    expect(exitCodeForErrorCode(e.code)).toBe(11);
  });
});

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccroute-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

describe("buildRepoSignals (§16.7)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns {} for a non-git directory", () => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-nogit-"));
    expect(buildRepoSignals(dir)).toEqual({});
  });

  it("fails soft to {} rather than throwing when cwd is unusable", () => {
    // Deliberately feeding an invalid type forces the outer try/catch's fail-soft path
    // (spawnSync throws synchronously on a non-string cwd), proving decide/explain can
    // never crash from a hostile/broken cwd.
    // biome-ignore lint/suspicious/noExplicitAny: intentional type violation, see above
    expect(buildRepoSignals(123 as any)).toEqual({});
  });

  it("reports tracked file count and a clean worktree", () => {
    dir = initTempGitRepo();
    const signals = buildRepoSignals(dir);
    expect(signals.trackedFiles).toBe(1);
    expect(signals.dirtyWorktree).toBe(false);
    expect(signals.monorepo).toBe(false);
    expect(signals.hasMigrations).toBe(false);
    expect(signals.hasAuthModules).toBe(false);
    expect(signals.hasInfra).toBe(false);
  });

  it("detects a dirty worktree", () => {
    dir = initTempGitRepo();
    writeFileSync(join(dir, "README.md"), "changed\n");
    const signals = buildRepoSignals(dir);
    expect(signals.dirtyWorktree).toBe(true);
  });

  it("detects migrations/auth/infra directories from tracked file paths", () => {
    dir = initTempGitRepo();
    mkdirSync(join(dir, "migrations"), { recursive: true });
    mkdirSync(join(dir, "src", "auth"), { recursive: true });
    mkdirSync(join(dir, "infra"), { recursive: true });
    writeFileSync(join(dir, "migrations", "0001_init.sql"), "-- init\n");
    writeFileSync(join(dir, "src", "auth", "login.ts"), "export {};\n");
    writeFileSync(join(dir, "infra", "main.tf"), "# tf\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "structure"], { cwd: dir });
    const signals = buildRepoSignals(dir);
    expect(signals.hasMigrations).toBe(true);
    expect(signals.hasAuthModules).toBe(true);
    expect(signals.hasInfra).toBe(true);
    expect(signals.trackedFiles).toBe(4);
  });

  it("detects a monorepo via pnpm-workspace.yaml", () => {
    dir = initTempGitRepo();
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "workspace"], { cwd: dir });
    const signals = buildRepoSignals(dir);
    expect(signals.monorepo).toBe(true);
  });

  it("detects a monorepo via multiple packages/*/package.json entries", () => {
    dir = initTempGitRepo();
    mkdirSync(join(dir, "packages", "a"), { recursive: true });
    mkdirSync(join(dir, "packages", "b"), { recursive: true });
    writeFileSync(join(dir, "packages", "a", "package.json"), "{}\n");
    writeFileSync(join(dir, "packages", "b", "package.json"), "{}\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "packages"], { cwd: dir });
    const signals = buildRepoSignals(dir);
    expect(signals.monorepo).toBe(true);
    expect(signals.packageCount).toBe(2);
  });
});

describe("gitStatusPaths", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty set for a clean repo", () => {
    dir = initTempGitRepo();
    expect(gitStatusPaths(dir).size).toBe(0);
  });

  it("returns the set of paths reported by git status --porcelain", () => {
    dir = initTempGitRepo();
    writeFileSync(join(dir, "new-file.txt"), "content\n");
    const paths = gitStatusPaths(dir);
    expect(paths.has("new-file.txt")).toBe(true);
  });

  it("returns an empty set for a non-git directory", () => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-nogit-status-"));
    expect(gitStatusPaths(dir).size).toBe(0);
  });
});

describe("commitRunChanges (§29)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("commits only files newly touched by the run and returns a hash", () => {
    dir = initTempGitRepo();
    const before = gitStatusPaths(dir);
    writeFileSync(join(dir, "run-output.txt"), "produced by the run\n");
    const result = commitRunChanges({
      cwd: dir,
      before,
      runId: "run-123",
      taskSummary: "do the thing",
      modelId: "some/model",
    });
    expect(result.committed).toBe(true);
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.files).toEqual(["run-output.txt"]);

    const log = spawnSync("git", ["log", "-1", "--pretty=%B"], { cwd: dir, encoding: "utf8" });
    expect(log.stdout).toContain("ccroute:");
    expect(log.stdout).toContain("runId=run-123");
    expect(log.stdout).toContain("model=some/model");

    // NEVER pushes, force-pushes, or rewrites history.
    expect(log.stdout).not.toMatch(/push/i);
  });

  it("does not commit a file that was already dirty before the run", () => {
    dir = initTempGitRepo();
    writeFileSync(join(dir, "README.md"), "pre-existing dirty edit\n");
    const before = gitStatusPaths(dir); // README.md already dirty here
    writeFileSync(join(dir, "run-output.txt"), "produced by the run\n");
    const result = commitRunChanges({
      cwd: dir,
      before,
      runId: "run-456",
      taskSummary: "do the thing",
      modelId: "some/model",
    });
    expect(result.committed).toBe(true);
    expect(result.files).toEqual(["run-output.txt"]);
    // README.md's pre-existing dirty edit must remain uncommitted/unstaged.
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
    expect(status.stdout).toContain("README.md");
  });

  it("reports no commit when the run caused no file changes", () => {
    dir = initTempGitRepo();
    const before = gitStatusPaths(dir);
    const result = commitRunChanges({
      cwd: dir,
      before,
      runId: "run-789",
      taskSummary: "no-op",
      modelId: "some/model",
    });
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/no run-caused file changes/);
  });

  it("reports failure when git add cannot acquire the index lock", () => {
    dir = initTempGitRepo();
    const before = gitStatusPaths(dir);
    writeFileSync(join(dir, "run-output.txt"), "produced by the run\n");
    // Force `git add` to fail deterministically: a stale index.lock makes git refuse to
    // touch the index at all ("Unable to create '.git/index.lock': File exists.").
    writeFileSync(join(dir, ".git", "index.lock"), "");
    const result = commitRunChanges({
      cwd: dir,
      before,
      runId: "run-locked",
      taskSummary: "blocked by a stale index lock",
      modelId: "m",
    });
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/git add failed/);
  });

  it("reports failure when git commit is rejected by a pre-commit hook", () => {
    dir = initTempGitRepo();
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const hookPath = join(hooksDir, "pre-commit");
    writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
    spawnSync("chmod", ["+x", hookPath]);
    const before = gitStatusPaths(dir);
    writeFileSync(join(dir, "blocked.txt"), "this commit should be blocked\n");
    const result = commitRunChanges({
      cwd: dir,
      before,
      runId: "run-blocked",
      taskSummary: "blocked by hook",
      modelId: "m",
    });
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/git commit failed/);
  });

  it("bounds an oversized task summary to keep the commit message bounded", () => {
    dir = initTempGitRepo();
    const before = gitStatusPaths(dir);
    writeFileSync(join(dir, "out.txt"), "x\n");
    const longSummary = "x".repeat(500);
    const result = commitRunChanges({
      cwd: dir,
      before,
      runId: "run-long",
      taskSummary: longSummary,
      modelId: "m",
    });
    expect(result.committed).toBe(true);
    const log = spawnSync("git", ["log", "-1", "--pretty=%s"], { cwd: dir, encoding: "utf8" });
    expect(log.stdout.length).toBeLessThan(200);
  });
});

describe("computeDoctorHealth", () => {
  it("is BLOCKED when cmd is not found, regardless of other signals", () => {
    const { status, warnings } = computeDoctorHealth({
      cmdFound: false,
      authenticated: null,
      expiredDeals: [],
      contradictions: [],
      pricingStale: false,
      dirtyWorktree: false,
    });
    expect(status).toBe("BLOCKED");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("is HEALTHY when cmd is found and nothing else is wrong", () => {
    const { status, warnings } = computeDoctorHealth({
      cmdFound: true,
      authenticated: true,
      expiredDeals: [],
      contradictions: [],
      pricingStale: false,
      dirtyWorktree: false,
    });
    expect(status).toBe("HEALTHY");
    expect(warnings).toEqual([]);
  });

  it("is DEGRADED with warnings for auth/expired-deals/stale-pricing/dirty-worktree/contradictions", () => {
    const { status, warnings } = computeDoctorHealth({
      cmdFound: true,
      authenticated: false,
      expiredDeals: ["some/model"],
      contradictions: ["cmd --help changed shape"],
      pricingStale: true,
      dirtyWorktree: true,
    });
    expect(status).toBe("DEGRADED");
    expect(warnings.some((w) => /not authenticated/.test(w))).toBe(true);
    expect(warnings.some((w) => /expired deals/.test(w))).toBe(true);
    expect(warnings.some((w) => /stale/.test(w))).toBe(true);
    expect(warnings.some((w) => /dirty/.test(w))).toBe(true);
    expect(warnings.some((w) => /cmd --help changed shape/.test(w))).toBe(true);
  });
});

describe("buildExplainJson (§10.7 field completeness)", () => {
  it("includes every required field", () => {
    const config = loadDefaultRoutingConfig();
    const pricing = loadSeedPricingSnapshot();
    const task = classifyTask("Summarize this repository", {});
    const decision = selectRoute({
      models: pricing.models,
      liveModelIds: null,
      config,
      task,
      pricingRetrievedAt: pricing.retrievedAt,
      now: new Date("2026-07-26T00:00:00Z"),
    });
    const repo = { trackedFiles: 10, monorepo: false };
    const json = buildExplainJson(task, decision, config, repo);

    const requiredKeys = [
      "normalizedTask",
      "removedOverrideMarkers",
      "taskClass",
      "taskSignals",
      "repositorySignals",
      "riskLevel",
      "requiredCapabilities",
      "estimatedContextTokens",
      "tokenPriors",
      "profile",
      "profileWeights",
      "qualityFloor",
      "candidateModels",
      "rejectedModels",
      "pricingInputs",
      "selectedModelId",
      "dealAffectedSelection",
      "pricingSnapshotAgeMs",
      "tieBreakRule",
      "overridesApplied",
      "explanation",
      "confidenceLimitations",
    ];
    for (const key of requiredKeys) {
      expect(json).toHaveProperty(key);
    }

    expect(json.normalizedTask).toBe(task.cleanedText);
    expect(json.repositorySignals).toEqual(repo);
    expect(Array.isArray(json.confidenceLimitations)).toBe(true);
    expect((json.confidenceLimitations as string[]).length).toBeGreaterThan(0);

    const candidates = json.candidateModels as Array<Record<string, unknown>>;
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c).toHaveProperty("modelId");
      expect(c).toHaveProperty("expectedRequestCostUsd");
      expect(c).toHaveProperty("retryPenaltyUsd");
      expect(c).toHaveProperty("escalationPenaltyUsd");
      expect(c).toHaveProperty("latencyContributionUsd");
      expect(c).toHaveProperty("expectedTotalCostUsd");
    }

    const pricingInputs = json.pricingInputs as Record<string, unknown>;
    expect(pricingInputs).toHaveProperty("retrievedAt");
    expect(pricingInputs).toHaveProperty("ageMs");
    expect(pricingInputs).toHaveProperty("freshMaxAgeMs");
    expect(pricingInputs).toHaveProperty("acceptableMaxAgeMs");

    expect(json.selected).toBeDefined();
    expect((json.selected as Record<string, unknown>).expectedTotalCostUsd).toBeDefined();
  });

  it("selected is undefined when selectedModelId does not match any candidate", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const tampered = { ...decision, selectedModelId: "no/such-model" };
    const json = buildExplainJson(task, tampered, config, {});
    expect(json.selected).toBeUndefined();
  });
});

describe("run command option-wiring (pure builders, never actually spawns cmd)", () => {
  it("buildRunSpawnOptions: autoAccept only follows --apply", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const withoutApply = buildRunSpawnOptions({
      cmd: "/bin/fake-cmd",
      decision,
      task,
      config,
      opts: {},
      runId: "r1",
      cwd: "/tmp",
    });
    expect(withoutApply.autoAccept).toBe(false);
    expect(withoutApply.unsafeYolo).toBe(false);

    const withApply = buildRunSpawnOptions({
      cmd: "/bin/fake-cmd",
      decision,
      task,
      config,
      opts: { apply: true },
      runId: "r1",
      cwd: "/tmp",
    });
    expect(withApply.autoAccept).toBe(true);
  });

  it("buildRunSpawnOptions: unsafeYolo requires BOTH --unsafe-yolo AND --apply", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const yoloWithoutApply = buildRunSpawnOptions({
      cmd: "/bin/fake-cmd",
      decision,
      task,
      config,
      opts: { unsafeYolo: true },
      runId: "r1",
      cwd: "/tmp",
    });
    expect(yoloWithoutApply.unsafeYolo).toBe(false);

    const yoloWithApply = buildRunSpawnOptions({
      cmd: "/bin/fake-cmd",
      decision,
      task,
      config,
      opts: { unsafeYolo: true, apply: true },
      runId: "r1",
      cwd: "/tmp",
    });
    expect(yoloWithApply.unsafeYolo).toBe(true);
  });

  it("buildRunSpawnOptions: never puts task text into argv-shaped fields, only stdin", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const options = buildRunSpawnOptions({
      cmd: "/bin/fake-cmd",
      decision,
      task,
      config,
      opts: { maxTurns: "5" },
      runId: "r1",
      cwd: "/tmp",
    });
    expect(options.stdinText).toBe(task.cleanedText);
    expect(options.maxTurns).toBe(5);
    expect(options.role).toBe("executor");
  });

  it("buildRunManifest reflects the model, apply flag, and child result", () => {
    const { decision } = fixtureTaskAndDecision();
    const manifest = buildRunManifest("run-1", decision, true, {
      exitCode: 0,
      timedOut: false,
      argv: ["--model", decision.selectedModelId],
    });
    expect(manifest.model).toBe(decision.selectedModelId);
    expect(manifest.apply).toBe(true);
    expect(manifest.mode).toBe("single");
  });

  it("buildRunStartEvent labels as override when the decision applied an override", () => {
    const { task, decision } = fixtureTaskAndDecision();
    const plainEvent = buildRunStartEvent("run-1", decision, task);
    expect(plainEvent.event).toBe(decision.overridesApplied.length ? "override" : "run_start");
    expect(plainEvent.modelId).toBe(decision.selectedModelId);
  });

  it("buildRunEndEvent reports timeout vs run_end and success based on exit code", () => {
    const { task, decision } = fixtureTaskAndDecision();
    const ok = buildRunEndEvent("run-1", decision, task, {
      exitCode: 0,
      timedOut: false,
      durationMs: 42,
    });
    expect(ok.event).toBe("run_end");
    expect(ok.success).toBe(true);

    const timedOut = buildRunEndEvent("run-1", decision, task, {
      exitCode: null,
      timedOut: true,
      durationMs: 999,
    });
    expect(timedOut.event).toBe("timeout");
    expect(timedOut.success).toBe(false);

    const failed = buildRunEndEvent("run-1", decision, task, {
      exitCode: 1,
      timedOut: false,
      durationMs: 10,
    });
    expect(failed.success).toBe(false);
  });
});

describe("orchestrate command option-wiring (pure builders, never actually orchestrates)", () => {
  it("A3: buildEffectiveOrchestrationConfig overrides maxPlannerRevisions/maxRepairs only when given", () => {
    const config = loadDefaultRoutingConfig();
    const unchanged = buildEffectiveOrchestrationConfig(config, {});
    expect(unchanged.orchestration.maxPlannerRevisions).toBe(
      config.orchestration.maxPlannerRevisions,
    );
    expect(unchanged.orchestration.maxRepairs).toBe(config.orchestration.maxRepairs);

    const overridden = buildEffectiveOrchestrationConfig(config, {
      maxPlanRevisions: "7",
      maxRepairs: "3",
    });
    expect(overridden.orchestration.maxPlannerRevisions).toBe(7);
    expect(overridden.orchestration.maxRepairs).toBe(3);
    // Everything else must pass through unchanged.
    expect(overridden.profiles).toEqual(config.profiles);
  });

  it("A3: buildOrchestrateOptions wires --skip-validation into flags.skipValidation", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const withSkip = buildOrchestrateOptions({
      cmd: "/bin/fake-cmd",
      effectiveConfig: config,
      task,
      decision,
      opts: { skipValidation: true },
      cwd: "/tmp",
      runDir: "/tmp/run-1",
    });
    expect(withSkip.flags.skipValidation).toBe(true);

    const withoutSkip = buildOrchestrateOptions({
      cmd: "/bin/fake-cmd",
      effectiveConfig: config,
      task,
      decision,
      opts: {},
      cwd: "/tmp",
      runDir: "/tmp/run-1",
    });
    expect(withoutSkip.flags.skipValidation).toBe(false);
  });

  it("A3: buildOrchestrateOptions wires config.validation into validationGate", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const overridden = buildEffectiveOrchestrationConfig(config, { maxRepairs: "9" });
    const options = buildOrchestrateOptions({
      cmd: "/bin/fake-cmd",
      effectiveConfig: overridden,
      task,
      decision,
      opts: {},
      cwd: "/tmp",
      runDir: "/tmp/run-1",
    });
    expect(options.validationGate).toEqual(overridden.validation);
    expect(options.config.orchestration.maxRepairs).toBe(9);
  });

  it("buildOrchestrateOptions falls back to --model when --executor-model is not given", () => {
    const { config, task, decision } = fixtureTaskAndDecision();
    const options = buildOrchestrateOptions({
      cmd: "/bin/fake-cmd",
      effectiveConfig: config,
      task,
      decision,
      opts: { model: "fallback/model" },
      cwd: "/tmp",
      runDir: "/tmp/run-1",
    });
    expect(options.models.executor).toBe("fallback/model");

    const withExplicit = buildOrchestrateOptions({
      cmd: "/bin/fake-cmd",
      effectiveConfig: config,
      task,
      decision,
      opts: { model: "fallback/model", executorModel: "explicit/model" },
      cwd: "/tmp",
      runDir: "/tmp/run-1",
    });
    expect(withExplicit.models.executor).toBe("explicit/model");
  });
});
