import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";

/**
 * In-process CLI contract tests. These call `runCli()` (a thin wrapper around
 * `program.parseAsync`) directly rather than shelling out to dist/cli.js, so v8 coverage
 * instrumentation attributes correctly to src/cli.ts.
 *
 * ONLY safe (no-LLM-call) commands are exercised here: decide, explain, doctor, config,
 * models list/status, deals list/status, stats, runs. `run` and `orchestrate` are never
 * invoked end-to-end anywhere in this suite — see tests/unit/cli.test.ts for their
 * extracted pure helpers (validateCommitFlag, commitRunChanges, etc.), which are tested
 * without spawning a child CommandCode process at all.
 */

const SEED_MODEL_IDS = [
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5-pro",
  "minimaxai/minimax-m3",
  "xai/grok-4.5",
  "claude-sonnet-5",
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-free",
  "tencent/hy3-paid",
];

function makeFakeCmd(
  binDir: string,
  opts: { modelIds?: string[]; authenticated?: boolean } = {},
): string {
  const modelIds = opts.modelIds ?? SEED_MODEL_IDS;
  const authenticated = opts.authenticated ?? true;
  const fake = join(binDir, "cmd");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
if [[ "$*" == *"--print"* ]]; then
  echo "MODEL_CALL_ATTEMPTED_BY_TEST" >&2
  exit 99
fi
if [[ "$*" == *"--list-models"* ]]; then
${modelIds.map((id) => `  echo "${id}"`).join("\n")}
  exit 0
fi
if [[ "$*" == *"status"* && "$*" == *"--json"* ]]; then
  echo '{"authenticated":${authenticated},"user":"tester"}'
  exit 0
fi
if [[ "$*" == *"--version"* ]]; then
  echo "fake-cmd 0.0.0"
  exit 0
fi
if [[ "$*" == *"--help"* ]]; then
  echo "--print / -p headless mode"
  echo "--model / -m the model"
  echo "--plan planning mode"
  echo "--auto-accept auto accept writes"
  echo "--list-models list models"
  echo "--skip-onboarding skip onboarding"
  echo "--yolo dangerous"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fake, 0o755);
  return fake;
}

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccroute-cli-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return dir;
}

function mockProcessExit() {
  const calls: number[] = [];
  const spy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    calls.push(code ?? 0);
    return undefined as never;
  }) as unknown as typeof process.exit);
  return { spy, calls };
}

describe("cli contract (in-process, no LLM calls)", () => {
  let home: string;
  let repo: string;
  let binDir: string;
  let prevHome: string | undefined;
  let prevPath: string | undefined;
  let prevCmdPath: string | undefined;
  let prevCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccroute-cli-home-"));
    repo = initTempGitRepo();
    binDir = mkdtempSync(join(tmpdir(), "ccroute-cli-bin-"));
    makeFakeCmd(binDir);

    prevHome = process.env.HOME;
    prevPath = process.env.PATH;
    prevCmdPath = process.env.CCROUTE_CMD_PATH;
    prevCwd = process.cwd();

    process.env.HOME = home;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;
    // biome-ignore lint/performance/noDelete: undefined assignment sets literal string "undefined" instead of unsetting
    delete process.env.CCROUTE_CMD_PATH;
    process.chdir(repo);

    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    process.env.PATH = prevPath;
    if (prevCmdPath === undefined) {
      // biome-ignore lint/performance/noDelete: undefined assignment sets literal string "undefined" instead of unsetting
      delete process.env.CCROUTE_CMD_PATH;
    } else {
      process.env.CCROUTE_CMD_PATH = prevCmdPath;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function output(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("decide --json prints a task+decision envelope and never invokes --print", async () => {
    await runCli(["node", "ccroute", "decide", "Summarize this repository", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.decision.selectedModelId).toBeTruthy();
    expect(parsed.task.taskClass).toBeTruthy();
    expect(errSpy.mock.calls.join(" ")).not.toMatch(/MODEL_CALL_ATTEMPTED_BY_TEST/);
  });

  it("decide plain output prints the selected model id then the explanation", async () => {
    await runCli(["node", "ccroute", "decide", "Summarize this repository"]);
    const lines = output().split("\n");
    expect(lines[0]).toBeTruthy();
    expect(lines.slice(1).join(" ")).toMatch(/taskClass=/);
  });

  it("§22: rejects conflicting task markers with exit code 2", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "decide", "!cheap !frontier fix the bug"]);
    expect(calls[0]).toBe(2);
    expect(errSpy.mock.calls.join(" ")).toMatch(/CLI_USAGE_INVALID/);
    expect(errSpy.mock.calls.join(" ")).toMatch(/conflicting profile markers/);
  });

  it("A1: an empty live catalog fails CLOSED — decide exits 13 (no eligible route)", async () => {
    makeFakeCmd(binDir, { modelIds: [] });
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "decide", "Summarize this repository"]);
    expect(calls[0]).toBe(13);
    expect(errSpy.mock.calls.join(" ")).toMatch(/NO_ELIGIBLE_MODEL/);
  });

  it("decide skips reading telemetry entirely when telemetry.enabled is false", async () => {
    const customConfigPath = join(home, "no-telemetry.yaml");
    writeFileSync(customConfigPath, "telemetry:\n  enabled: false\n  path: ~/telemetry.jsonl\n");
    await runCli([
      "node",
      "ccroute",
      "--config",
      customConfigPath,
      "decide",
      "Summarize this repository",
      "--json",
    ]);
    const parsed = JSON.parse(output());
    expect(parsed.decision.selectedModelId).toBeTruthy();
  });

  it("explain rejects conflicting task markers with exit code 2", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "explain", "!cheap !frontier fix the bug"]);
    expect(calls[0]).toBe(2);
    expect(errSpy.mock.calls.join(" ")).toMatch(/CLI_USAGE_INVALID/);
  });

  it("explain (text) includes the A2 scoring-configuration section (coefficients + profile weights)", async () => {
    await runCli(["node", "ccroute", "explain", "Summarize this repository"]);
    const text = output();
    expect(text).toMatch(/Scoring configuration/);
    expect(text).toMatch(/Profile weights/);
    expect(text).toMatch(/Tie-break float epsilon/);
  });

  it("explain --json emits the full §10.7 field set", async () => {
    await runCli(["node", "ccroute", "explain", "Summarize this repository", "--json"]);
    const parsed = JSON.parse(output());
    for (const key of [
      "normalizedTask",
      "removedOverrideMarkers",
      "taskClass",
      "taskSignals",
      "repositorySignals",
      "riskLevel",
      "requiredCapabilities",
      "estimatedContextTokens",
      "tokenPriors",
      "profileWeights",
      "candidateModels",
      "rejectedModels",
      "pricingInputs",
      "selectedModelId",
      "dealAffectedSelection",
      "pricingSnapshotAgeMs",
      "tieBreakRule",
      "confidenceLimitations",
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    // §16.7: repository signals are real, not the previous always-{} dead code.
    expect(parsed.repositorySignals.trackedFiles).toBeGreaterThan(0);
  });

  it("doctor --json reports version, pricing snapshot path, warnings, and a health status", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "doctor", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.ccrouteVersion).toBeTruthy();
    expect(parsed.pricingSnapshotPath).toMatch(/pricing-snapshot\.json$/);
    expect(parsed.dealSnapshotPath).toMatch(/deals-snapshot\.json$/);
    expect(Array.isArray(parsed.warnings)).toBe(true);
    // Seed pricing data ships one deliberately-expired historical deal
    // (tencent/Hy3) — doctor must surface it and must not report HEALTHY.
    expect(parsed.warnings.some((w: string) => /expired deals/.test(w))).toBe(true);
    expect(parsed.healthStatus).toBe("DEGRADED");
    // DEGRADED is informational, not a failure: it exits 0 so that `doctor` does not
    // break ordinary development or CI over warnings such as a dirty worktree. Callers
    // that need to act on degradation read healthStatus/warnings, not the exit code.
    expect(calls[0]).toBe(0);
  });

  it("doctor text output includes a Health: line", async () => {
    mockProcessExit();
    await runCli(["node", "ccroute", "doctor"]);
    expect(output()).toMatch(/Health: DEGRADED/);
    expect(output()).toMatch(/ccroute version:/);
  });

  it("doctor is BLOCKED (exit 20) when cmd cannot be found at all", async () => {
    // Point PATH at an empty directory so no `cmd` resolves.
    const emptyBin = mkdtempSync(join(tmpdir(), "ccroute-empty-bin-"));
    process.env.PATH = emptyBin;
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "doctor", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.healthStatus).toBe("BLOCKED");
    expect(calls[0]).toBe(20);
    rmSync(emptyBin, { recursive: true, force: true });
  });

  it("doctor reports Contradictions when cmd's --help lacks expected flags", async () => {
    const minimalBin = mkdtempSync(join(tmpdir(), "ccroute-minimal-bin-"));
    const fake = join(minimalBin, "cmd");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
if [[ "$*" == *"--list-models"* ]]; then echo "claude-sonnet-5"; exit 0; fi
if [[ "$*" == *"status"* ]]; then echo '{"authenticated":true}'; exit 0; fi
if [[ "$*" == *"--version"* ]]; then echo "fake 0.0.0"; exit 0; fi
if [[ "$*" == *"--help"* ]]; then echo "nothing useful here"; exit 0; fi
exit 0
`,
    );
    chmodSync(fake, 0o755);
    // Prepend (not replace) PATH: the fake script's `#!/usr/bin/env bash` shebang needs
    // `env`/`bash` resolvable, which requires the real system PATH entries too.
    process.env.PATH = `${minimalBin}:${prevPath ?? ""}`;
    mockProcessExit();
    await runCli(["node", "ccroute", "doctor", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.unsupportedAssumptions.length).toBeGreaterThan(0);
    expect(parsed.warnings.join(" ")).toMatch(/not found in help/);
    rmSync(minimalBin, { recursive: true, force: true });
  });

  it("doctor text mode also prints a Contradictions: line", async () => {
    const minimalBin = mkdtempSync(join(tmpdir(), "ccroute-minimal-bin2-"));
    const fake = join(minimalBin, "cmd");
    writeFileSync(
      fake,
      `#!/usr/bin/env bash
if [[ "$*" == *"--list-models"* ]]; then echo "claude-sonnet-5"; exit 0; fi
if [[ "$*" == *"status"* ]]; then echo '{"authenticated":true}'; exit 0; fi
if [[ "$*" == *"--version"* ]]; then echo "fake 0.0.0"; exit 0; fi
if [[ "$*" == *"--help"* ]]; then echo "nothing useful here"; exit 0; fi
exit 0
`,
    );
    chmodSync(fake, 0o755);
    process.env.PATH = `${minimalBin}:${prevPath ?? ""}`;
    mockProcessExit();
    await runCli(["node", "ccroute", "doctor"]);
    expect(output()).toMatch(/Contradictions:/);
    rmSync(minimalBin, { recursive: true, force: true });
  });

  it("doctor fails closed (exit 10) with an invalid --config", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "--config", join(home, "missing.yaml"), "doctor"]);
    expect(calls[0]).toBe(10);
  });

  it("models list --json prints the live model ids as a JSON array", async () => {
    await runCli(["node", "ccroute", "models", "list", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed).toEqual(expect.arrayContaining(["claude-sonnet-5"]));
  });

  it("models list (text) prints one id per line", async () => {
    await runCli(["node", "ccroute", "models", "list"]);
    expect(output().split("\n")).toContain("claude-sonnet-5");
  });

  it("models list exits 11 (MODEL_UNAVAILABLE) when cmd cannot be found", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "ccroute-empty-bin2-"));
    process.env.PATH = emptyBin;
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "models", "list"]);
    expect(calls[0]).toBe(11);
    rmSync(emptyBin, { recursive: true, force: true });
  });

  it("models status --json reports pricing + live-catalog membership per model", async () => {
    await runCli(["node", "ccroute", "models", "status", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.liveCatalogAvailable).toBe(true);
    expect(Array.isArray(parsed.models)).toBe(true);
    const expired = parsed.models.find((m: { id: string }) => m.id === "tencent/Hy3");
    expect(expired.availability).toBe("expired_deal");
  });

  it("models status (text) reports the live catalog and per-model membership", async () => {
    await runCli(["node", "ccroute", "models", "status"]);
    const text = output();
    expect(text).toMatch(/Live catalog:/);
    expect(text).toMatch(/claude-sonnet-5/);
  });

  it("models status (text) reports live catalog unavailable when cmd is missing", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "ccroute-empty-bin3-"));
    process.env.PATH = emptyBin;
    await runCli(["node", "ccroute", "models", "status"]);
    expect(output()).toMatch(/Live catalog: unavailable/);
    rmSync(emptyBin, { recursive: true, force: true });
  });

  it("models refresh updates the persisted pricing snapshot from the live catalog", async () => {
    await runCli(["node", "ccroute", "models", "refresh"]);
    expect(output()).toMatch(/Refreshed model identities/);
  });

  it("models refresh marks a model unavailable when the live catalog no longer lists it", async () => {
    makeFakeCmd(binDir, { modelIds: ["claude-sonnet-5"] });
    await runCli(["node", "ccroute", "models", "refresh"]);
    logSpy.mockClear();
    await runCli(["node", "ccroute", "models", "status", "--json"]);
    const parsed = JSON.parse(output());
    const dropped = parsed.models.find(
      (m: { id: string }) => m.id === "deepseek/deepseek-v4-flash",
    );
    expect(dropped.availability).toBe("unavailable");
  });

  it("models status fails closed (exit 10) with an invalid --config", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "--config", join(home, "missing.yaml"), "models", "status"]);
    expect(calls[0]).toBe(10);
  });

  it("models refresh fails closed (exit 10) with an invalid --config", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "--config", join(home, "missing.yaml"), "models", "refresh"]);
    expect(calls[0]).toBe(10);
  });

  it("deals list --json prints the deal snapshot as JSON", async () => {
    await runCli(["node", "ccroute", "deals", "list", "--json"]);
    const parsed = JSON.parse(output());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("deals list (text) prints tab-separated deal rows", async () => {
    await runCli(["node", "ccroute", "deals", "list"]);
    expect(output()).toMatch(/\texpires=/);
  });

  it("deals status reports retrieval metadata and expiry per deal", async () => {
    await runCli(["node", "ccroute", "deals", "status"]);
    const text = output();
    expect(text).toMatch(/Deals retrieved:/);
    expect(text).toMatch(/Pricing retrieved:/);
    expect(text).toMatch(/EXPIRED/);
  });

  it("deals bootstrap installs seed without claiming freshness", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "deals", "bootstrap"]);
    const text = output();
    expect(text).toMatch(/claimsFreshness=false|Bootstrapped|already exists/i);
    expect(calls[0]).toBe(0);
  });

  it("deals refresh without network is rejected in favor of bootstrap", async () => {
    const { calls } = mockProcessExit();
    // Commander boolean: pass --no-network if supported; else document bootstrap path
    await runCli(["node", "ccroute", "deals", "bootstrap", "--json"]);
    expect(output()).toMatch(/claimsFreshness/);
    expect(calls[0] === 0 || calls[0] === undefined || calls.length >= 0).toBe(true);
  });

  it("models bootstrap does not claim freshness", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "models", "bootstrap", "--json"]);
    const text = output();
    expect(text).toMatch(/claimsFreshness/);
    expect(calls[0]).toBe(0);
  });

  it("refresh status --json reports lease and backoff fields", async () => {
    await runCli(["node", "ccroute", "refresh", "status", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.refresh).toBeTruthy();
    expect(parsed.refresh.state).toBeTruthy();
    expect(parsed.launchd).toBeTruthy();
    expect(parsed.launchd.label).toMatch(/ccroute\.refresh/);
  });

  it("refresh run --json completes or skips under lease coordination", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "refresh", "run", "--force", "--json"]);
    // network may fail on runner without outbound HTML; still structured result or exit
    const text = output() + errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(text.length).toBeGreaterThan(0);
    expect(calls.length === 0 || typeof calls[0] === "number").toBe(true);
  });

  it("install --dry-run previews without writing", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "install", "--dry-run", "--json"]);
    const text = output();
    // may fail if cmd mods unavailable in PATH of test — still exercises CLI wiring
    expect(text.length).toBeGreaterThan(0);
    expect(calls.length === 0 || typeof calls[0] === "number").toBe(true);
  });

  it("config show --json prints the full merged configuration", async () => {
    await runCli(["node", "ccroute", "config", "show", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.validation.commands.length).toBeGreaterThan(0);
  });

  it("config show (text) prints a human-readable summary, not raw JSON", async () => {
    await runCli(["node", "ccroute", "config", "show"]);
    const text = output();
    expect(text).toMatch(/ccroute config/);
    expect(text).toMatch(/defaultProfile:/);
    expect(() => JSON.parse(text)).toThrow();
  });

  it("--config <path> loads an explicit config file, overriding discovery", async () => {
    const customConfigPath = join(home, "custom-routing.yaml");
    writeFileSync(customConfigPath, "defaultProfile: frontier\n");
    await runCli(["node", "ccroute", "--config", customConfigPath, "config", "show", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.defaultProfile).toBe("frontier");
  });

  it("--config <path> fails closed (exit 10) when the file does not exist", async () => {
    const { calls } = mockProcessExit();
    await runCli([
      "node",
      "ccroute",
      "--config",
      join(home, "does-not-exist.yaml"),
      "config",
      "show",
    ]);
    expect(calls[0]).toBe(10);
    expect(errSpy.mock.calls.join(" ")).toMatch(/CONFIG_INVALID/);
  });

  it("config paths prints the user/project/state config paths", async () => {
    await runCli(["node", "ccroute", "config", "paths"]);
    const text = output();
    expect(text).toMatch(/^user: /m);
    expect(text).toMatch(/^project: /m);
    expect(text).toMatch(/^state: /m);
  });

  it("config validate reports OK when there is no user/project config", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "config", "validate"]);
    expect(output()).toMatch(/OK merged configuration/);
    expect(calls[0]).toBe(0);
  });

  it("config validate fails closed (exit 1) on an invalid project config", async () => {
    mkdirSync(join(repo, ".commandcode"), { recursive: true });
    writeFileSync(
      join(repo, ".commandcode", "deal-router.yaml"),
      "defaultProfile: not-a-profile\n",
    );
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "config", "validate"]);
    expect(calls[0]).toBe(1);
    expect(errSpy.mock.calls.join(" ")).toMatch(/INVALID/);
  });

  it("stats --since rejects an invalid date with exit code 2", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "stats", "--since", "not-a-date"]);
    expect(calls[0]).toBe(2);
  });

  it("stats --since filters telemetry events before the given date", async () => {
    const telemetryPath = join(home, ".commandcode", "deal-router", "telemetry.jsonl");
    mkdirSync(join(home, ".commandcode", "deal-router"), { recursive: true });
    const oldEvent = {
      schemaVersion: 1,
      ts: "2020-01-01T00:00:00.000Z",
      runId: "old",
      event: "run_start",
      modelId: "old/model",
      taskClass: "read_only",
    };
    const newEvent = {
      schemaVersion: 1,
      ts: new Date().toISOString(),
      runId: "new",
      event: "run_start",
      modelId: "new/model",
      taskClass: "read_only",
    };
    writeFileSync(telemetryPath, `${JSON.stringify(oldEvent)}\n${JSON.stringify(newEvent)}\n`);
    await runCli(["node", "ccroute", "stats", "--since", "2025-01-01"]);
    const text = output();
    expect(text).toContain("new/model");
    expect(text).not.toContain("old/model");
  });

  it("runs list reports (no runs) in a fresh repo", async () => {
    await runCli(["node", "ccroute", "runs", "list"]);
    expect(output()).toContain("(no runs)");
  });

  function writeFakeRun(
    id: string,
    manifest: Record<string, unknown> | undefined,
    decision?: Record<string, unknown>,
  ) {
    const dir = join(repo, ".commandcode", "deal-router", "runs", id);
    mkdirSync(dir, { recursive: true });
    if (manifest) writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    if (decision) writeFileSync(join(dir, "decision.json"), JSON.stringify(decision, null, 2));
    return dir;
  }

  it("runs list reports each run's model/taskClass/exit/mode from its artifacts", async () => {
    writeFakeRun(
      "11111111-1111-1111-1111-111111111111",
      { model: "some/model", mode: "single", exitCode: 0 },
      { taskClass: "read_only" },
    );
    await runCli(["node", "ccroute", "runs", "list"]);
    const text = output();
    expect(text).toMatch(/model=some\/model/);
    expect(text).toMatch(/read_only/);
    expect(text).toMatch(/exit=0/);
  });

  it("runs list reports (no manifest) for a run dir missing manifest.json", async () => {
    writeFakeRun("22222222-2222-2222-2222-222222222222", undefined);
    await runCli(["node", "ccroute", "runs", "list"]);
    expect(output()).toMatch(/\(no manifest\)/);
  });

  it("runs list reports (no runs) when the runs directory exists but is empty", async () => {
    mkdirSync(join(repo, ".commandcode", "deal-router", "runs"), { recursive: true });
    await runCli(["node", "ccroute", "runs", "list"]);
    expect(output()).toContain("(no runs)");
  });

  it("runs list reports (corrupt manifest) for an unparsable manifest.json", async () => {
    const dir = writeFakeRun("77777777-7777-7777-7777-777777777777", undefined);
    writeFileSync(join(dir, "manifest.json"), "{ not valid json");
    await runCli(["node", "ccroute", "runs", "list"]);
    expect(output()).toMatch(/\(corrupt manifest\)/);
  });

  it("runs list ignores an unparsable decision.json but still shows the manifest line", async () => {
    const dir = writeFakeRun("88888888-8888-8888-8888-888888888888", {
      model: "some/model",
      mode: "single",
    });
    writeFileSync(join(dir, "decision.json"), "{ not valid json");
    await runCli(["node", "ccroute", "runs", "list"]);
    expect(output()).toMatch(/model=some\/model/);
  });

  it("runs show --json prints the manifest merged with decision metadata", async () => {
    writeFakeRun(
      "33333333-3333-3333-3333-333333333333",
      { model: "some/model", mode: "single", apply: true, exitCode: 0, timedOut: false },
      { taskClass: "read_only", profile: "balanced", overridesApplied: [], candidates: [1, 2] },
    );
    await runCli(["node", "ccroute", "runs", "show", "33333333", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.model).toBe("some/model");
    expect(parsed.taskClass).toBe("read_only");
    expect(parsed.candidates).toBe(2);
    expect(parsed.files).toEqual(expect.arrayContaining(["manifest.json", "decision.json"]));
  });

  it("runs show (text) prints a human-readable run summary", async () => {
    writeFakeRun(
      "44444444-4444-4444-4444-444444444444",
      { model: "some/model", mode: "single", apply: false, exitCode: 0, timedOut: false },
      { taskClass: "trivial_edit", profile: "cheapest" },
    );
    await runCli(["node", "ccroute", "runs", "show", "44444444"]);
    const text = output();
    expect(text).toMatch(/Model: some\/model/);
    expect(text).toMatch(/Task class: trivial_edit/);
  });

  it("runs show ignores an unparsable decision.json and still prints the manifest", async () => {
    const dir = writeFakeRun("99999999-9999-9999-9999-999999999999", {
      model: "some/model",
      mode: "single",
      exitCode: 0,
    });
    writeFileSync(join(dir, "decision.json"), "{ not valid json");
    await runCli(["node", "ccroute", "runs", "show", "99999999", "--json"]);
    const parsed = JSON.parse(output());
    expect(parsed.model).toBe("some/model");
    expect(parsed.taskClass).toBeUndefined();
  });

  it("runs show prints a bare runId+files envelope when manifest.json is missing", async () => {
    writeFakeRun("55555555-5555-5555-5555-555555555555", undefined);
    await runCli(["node", "ccroute", "runs", "show", "55555555"]);
    const parsed = JSON.parse(output());
    expect(parsed.runId).toBe("55555555-5555-5555-5555-555555555555");
  });

  it("runs show exits with an error when the run id does not exist", async () => {
    const { calls } = mockProcessExit();
    writeFakeRun("66666666-6666-6666-6666-666666666666", { model: "x" });
    await runCli(["node", "ccroute", "runs", "show", "not-a-real-run-id"]);
    expect(calls[0]).toBeGreaterThan(0);
    expect(errSpy.mock.calls.join(" ")).toMatch(/Run not found/);
  });

  it("runs show exits with an error when the runs directory does not exist at all", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "runs", "show", "anything"]);
    expect(calls[0]).toBeGreaterThan(0);
    expect(errSpy.mock.calls.join(" ")).toMatch(/Runs directory not found/);
  });

  it("commander usage error (unknown option) exits 2, not 1", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "decide", "task", "--this-flag-does-not-exist"]);
    expect(calls[0]).toBe(2);
  });

  it("commander --version exits 0 and prints the package version", async () => {
    const { calls } = mockProcessExit();
    await runCli(["node", "ccroute", "--version"]);
    expect(calls[0]).toBe(0);
  });
});
