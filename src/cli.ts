#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Command, CommanderError } from "commander";
import type { RepoSignals } from "./classifier/deterministic.js";
import { classifyTask } from "./classifier/deterministic.js";
import { CliUsageError, EXIT, exitCodeForErrorCode, mapOrchestrateExit } from "./cli/exit-codes.js";
import { packageRoot } from "./config/defaults.js";
import {
  loadConfig,
  projectConfigPath,
  stateDir,
  userConfigPath,
  validateConfigFile,
} from "./config/loader.js";
import { ConfigError } from "./config/merge.js";
import type { RoutingConfig } from "./config/schemas.js";
import { probeCapabilities } from "./discovery/capability-probe.js";
import { resolveCmdPath } from "./discovery/commandcode-cli.js";
import { fetchLiveModelIds } from "./discovery/model-catalog.js";
import type { RouteDecision } from "./domain/route.js";
import type { ClassifiedTask, RoutingProfile } from "./domain/task.js";
import {
  type InstallCliOptions,
  formatLifecycleResult,
  installLifecycle,
  repairLifecycle,
  statusLifecycle,
  uninstallLifecycle,
  updateLifecycle,
} from "./install/index.js";
import { InstallError } from "./install/types.js";
import { orchestrate, shouldOrchestrate } from "./orchestration/orchestrator.js";
import {
  classifySnapshotFreshness,
  dealsSnapshotPath,
  loadDealSnapshot,
  loadPricingSnapshot,
  pricingSnapshotPath,
  snapshotAgeMs,
} from "./pricing/snapshot.js";
import {
  bootstrapBoth,
  bootstrapDealSnapshot,
  bootstrapPricingSnapshot,
  getRefreshStatus,
  installLaunchd,
  resolveCcrouteAbsolute,
  runCoordinatedRefresh,
  statusLaunchd,
  uninstallLaunchd,
} from "./refresh/index.js";
import { formatExplain } from "./router/explain.js";
import { RouteError, selectRoute } from "./router/select.js";
import { estimateContextTokens, estimateRequestTokens } from "./router/token-estimate.js";
import { warnUnsafeYolo } from "./security/command-policy.js";
import { defaultGitPorcelainStatus, ensureGitSafety } from "./security/git-safety.js";
import { assertPathInsideRoot } from "./security/path-policy.js";
import {
  RecursionError,
  assertCcrouteEntryAllowed,
  assertPrimaryRecursionGuard,
} from "./security/recursion-guard.js";
import { spawnCommandCode } from "./subprocess/commandcode.js";
import { aggregateByModel, formatStats } from "./telemetry/aggregate.js";
import { redactText } from "./telemetry/redact.js";
import { appendTelemetry, readTelemetryEvents } from "./telemetry/store.js";

/** Reads ccroute's own version from package.json (never hardcoded twice — see
 * doctor's `ccrouteVersion` field, §29 requirement). Falls back to "0.0.0" only if
 * package.json is genuinely unreadable (should not happen in a real install). */
function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const CCROUTE_VERSION = getPackageVersion();

/** Typed so a missing `cmd` executable maps to EXIT.MODEL_UNAVAILABLE (11) via
 * exit-codes.ts's ERROR_CODE_EXIT_MAP, instead of falling through to the generic
 * internal-invariant-failure fallback. */
export class CmdNotFoundError extends Error {
  readonly code = "CMD_NOT_FOUND";
  constructor(message = "CommandCode `cmd` executable not found on PATH") {
    super(message);
    this.name = "CmdNotFoundError";
  }
}

const program = new Command();
program
  .name("ccroute")
  .description("Deterministic deal-aware CommandCode model router and role orchestrator")
  .version(CCROUTE_VERSION)
  .option(
    "--config <path>",
    "Explicit config file path (replaces user/project config discovery for this invocation)",
  )
  // Must be called before any .command(...) below: exitOverride/_exitCallback is copied
  // onto a subcommand only at the moment .command() creates it (see
  // Command.copyInheritedSettings in commander/lib/command.js).
  .exitOverride();

// Primary recursion boundary: reject nested external entry before any command action.
// assertCcrouteEntryAllowed remains on individual commands as defence-in-depth.
program.hook("preAction", () => {
  assertPrimaryRecursionGuard();
});

/**
 * §11: `fail()` never uses a bare, unmapped exit 1. Every error that reaches here either
 * carries a recognized `.code` (RouteError/ConfigError/RecursionError/CliUsageError/
 * CmdNotFoundError) that resolves to its taxonomy code, or falls back to
 * EXIT.INTERNAL_INVARIANT_FAILURE (50) — never to a generic "something went wrong, exit 1".
 */
function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof Error ? (err as { code?: string }).code : undefined;
  const exitCode = exitCodeForErrorCode(code);
  console.error(code ? `[${code}] ${msg}` : msg);
  process.exit(exitCode);
}

function loadRuntime(cli?: Record<string, unknown>) {
  const cliOverrides = cli && Object.keys(cli).length > 0 ? cli : undefined;
  const explicitConfigPath = program.opts().config as string | undefined;
  return loadConfig({ cliOverrides, explicitConfigPath });
}

/**
 * §22: `parseTaskMarkers` (src/classifier/deterministic.ts, not owned by this remediation
 * wave) applies its marker regex globally and silently lets the LAST match win when the
 * same override category is specified more than once (e.g. `!cheap !frontier` silently
 * resolves to "frontier"). This duplicates just enough of that regex's matching semantics
 * to DETECT the conflict (never to resolve it) so cli.ts can reject it outright with exit
 * 2, rather than silently routing on an ambiguous instruction.
 */
const PROFILE_MARKER_RE = /(?:^|\s)!(cheap|balanced|frontier)(?=\s|$)/gi;
const MODEL_MARKER_RE = /(?:^|\s)!model=([^\s]+)/gi;

export function detectMarkerConflicts(text: string): string[] {
  const conflicts: string[] = [];
  const profiles = new Set<string>();
  for (const m of text.matchAll(PROFILE_MARKER_RE)) profiles.add(m[1]!.toLowerCase());
  if (profiles.size > 1) {
    conflicts.push(`conflicting profile markers: ${[...profiles].map((p) => `!${p}`).join(", ")}`);
  }
  const models = new Set<string>();
  for (const m of text.matchAll(MODEL_MARKER_RE)) models.add(m[1]!);
  if (models.size > 1) {
    conflicts.push(
      `conflicting model markers: ${[...models].map((id) => `!model=${id}`).join(", ")}`,
    );
  }
  return conflicts;
}

/**
 * §16.7 repository signals. Cheap, non-secret, bounded metadata derived only from tracked
 * *file names/paths* (never file contents, never .env values, credential files, keychains,
 * or private keys) so `classifyTask`'s `RepoSignals` parameter (previously always `{}`,
 * i.e. dead code at every production call site) carries real data. Every git subprocess
 * call below is bounded by a short timeout so `decide`/`explain` stay fast; any failure
 * (not a git repo, git missing, timeout) fails soft to `{}` rather than blocking routing.
 */
export function buildRepoSignals(cwd: string): RepoSignals {
  try {
    const rev = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 2000,
    });
    if (rev.status !== 0 || rev.stdout.trim() !== "true") return {};

    const ls = spawnSync("git", ["ls-files"], {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 3000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = ls.status === 0 ? ls.stdout.split("\n").filter(Boolean) : [];
    const trackedFiles = files.length;
    const hasMigrations = files.some((f) => /(^|\/)migrations?\//i.test(f));
    const hasAuthModules = files.some((f) => /(^|\/)auth(entication)?\//i.test(f));
    const hasInfra = files.some((f) => /(^|\/)(infra|infrastructure|terraform|deploy)\//i.test(f));
    const packagePaths = files.filter((f) => /(^|\/)packages\/[^/]+\/package\.json$/.test(f));
    const monorepo =
      existsSync(join(cwd, "pnpm-workspace.yaml")) ||
      existsSync(join(cwd, "lerna.json")) ||
      existsSync(join(cwd, "turbo.json")) ||
      packagePaths.length > 1;

    // Deliberately NOT defaultGitPorcelainStatus() here: that helper always inspects
    // process.cwd(), whereas buildRepoSignals must inspect the caller-supplied `cwd`
    // (tests exercise this against a temp repo distinct from process.cwd()).
    const statusRes = spawnSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      shell: false,
      timeout: 2000,
    });
    const dirtyWorktree = statusRes.status === 0 && statusRes.stdout.trim().length > 0;

    return {
      trackedFiles,
      monorepo,
      ...(packagePaths.length > 0 ? { packageCount: packagePaths.length } : {}),
      hasMigrations,
      hasAuthModules,
      hasInfra,
      dirtyWorktree,
    };
  } catch {
    return {};
  }
}

/** Commander treats bare `--no-*` specially; accept both flags via argv. */
function wantsNoFree(opts: { excludeFree?: boolean; noFree?: boolean }): boolean {
  return Boolean(
    opts.excludeFree ||
      opts.noFree ||
      process.argv.includes("--no-free") ||
      process.argv.includes("--exclude-free"),
  );
}

export interface DecideCoreResult {
  task: ClassifiedTask;
  decision: RouteDecision;
  loaded: ReturnType<typeof loadConfig>;
  pricing: ReturnType<typeof loadPricingSnapshot>;
  cmd: string | null;
  repo: RepoSignals;
}

function decideCore(
  taskText: string,
  opts: {
    profile?: string;
    model?: string;
    noFree?: boolean;
    excludeFree?: boolean;
    maxEstimatedCost?: string;
    json?: boolean;
  },
): DecideCoreResult {
  assertCcrouteEntryAllowed();

  const conflicts = detectMarkerConflicts(taskText);
  if (conflicts.length > 0) {
    throw new CliUsageError(`Conflicting task markers: ${conflicts.join("; ")}`);
  }

  const noFree = wantsNoFree(opts);
  const loaded = loadRuntime({
    ...(noFree ? { noFree: true } : {}),
  });
  const repo = buildRepoSignals(process.cwd());
  const task = classifyTask(taskText, repo);
  const pricing = loadPricingSnapshot();
  const cmd = resolveCmdPath(loaded.config.cmdPath);

  // A1: distinguish "live catalog fetched and empty/unusable" (fail CLOSED — every
  // model is rejected, see router/eligibility.ts#LiveCatalogStatus) from "no cmd
  // configured at all" (intentional offline/seed mode, liveCatalogStatus left undefined
  // so filterEligible falls back to its legacy liveModelIds-only behavior).
  let liveIds: Set<string> | null = null;
  let liveCatalogStatus: "available" | "unavailable" | undefined;
  if (cmd) {
    const live = fetchLiveModelIds(cmd);
    if (live.ids.length) {
      liveIds = new Set(live.ids);
      liveCatalogStatus = "available";
    } else {
      liveCatalogStatus = "unavailable";
    }
  }

  const events = loaded.config.telemetry.enabled
    ? readTelemetryEvents(loaded.config.telemetry.path)
    : [];
  const telemetry = aggregateByModel(events);
  const decision = selectRoute({
    models: pricing.models,
    liveModelIds: liveIds,
    liveCatalogStatus,
    config: loaded.config,
    task,
    profile: opts.profile as RoutingProfile | undefined,
    telemetry,
    pricingRetrievedAt: pricing.retrievedAt,
    maxEstimatedCost: opts.maxEstimatedCost ? Number(opts.maxEstimatedCost) : undefined,
    noFree,
    cliModel: opts.model,
  });
  return { task, decision, loaded, pricing, cmd, repo };
}

program
  .command("decide")
  .argument("<task...>", "Task text")
  .option("--json", "JSON output")
  .option("--profile <profile>", "cheapest|balanced|frontier")
  .option("--model <id>", "Explicit model override")
  .option("--exclude-free", "Exclude free models")
  .option("--no-free", "Exclude free models (alias of --exclude-free)")
  .option("--max-estimated-cost <usd>", "Max expected cost")
  .action((taskParts: string[], opts) => {
    try {
      const { task, decision } = decideCore(taskParts.join(" "), opts);
      if (opts.json) {
        console.log(JSON.stringify({ task, decision }, null, 2));
      } else {
        console.log(decision.selectedModelId);
        console.log(decision.explanation);
      }
    } catch (e) {
      fail(e);
    }
  });

/**
 * §10.7 full field set for `explain --json`. Kept as a standalone exported function so it
 * can be unit-tested for field completeness without going through Commander at all.
 */
export function buildExplainJson(
  task: ClassifiedTask,
  decision: RouteDecision,
  config: RoutingConfig,
  repo: RepoSignals,
): Record<string, unknown> {
  const tokens = estimateRequestTokens(task, config);
  const estimatedContextTokensValue = estimateContextTokens(tokens);
  const weights = config.profiles[decision.profile];
  const sel = decision.candidates.find((c) => c.modelId === decision.selectedModelId);

  return {
    schemaVersion: 1,
    normalizedTask: task.cleanedText,
    removedOverrideMarkers: task.overrides,
    taskClass: decision.taskClass,
    taskSignals: task.signals,
    repositorySignals: repo,
    riskLevel: task.riskLevel,
    requiredCapabilities: task.requiredCapabilities,
    estimatedContextTokens: estimatedContextTokensValue,
    tokenPriors: config.task_classes[task.taskClass]?.token_priors,
    profile: decision.profile,
    profileWeights: weights,
    qualityFloor: decision.qualityFloor,
    candidateModels: decision.candidates.map((c) => ({
      modelId: c.modelId,
      qualityTier: c.qualityTier,
      preferred: c.preferred,
      score: c.score,
      successRatePrior: c.successRate,
      averageLatencyMsPrior: c.averageLatencyMs,
      expectedRequestCostUsd: c.cost.estimatedRequestCost,
      retryPenaltyUsd: c.cost.expectedRetryCost,
      escalationPenaltyUsd: c.cost.expectedEscalationCost,
      latencyContributionUsd: c.cost.latencyPenalty,
      expectedTotalCostUsd: c.cost.expectedTotalCost,
      priceBasis: c.cost.priceBasis,
      dealApplied: c.cost.dealApplied,
    })),
    rejectedModels: decision.rejected,
    pricingInputs: {
      retrievedAt: decision.pricingSnapshotRetrievedAt,
      ageMs: decision.pricingSnapshotAgeMs,
      freshMaxAgeMs: config.pricing.freshMaxAgeMs,
      acceptableMaxAgeMs: config.pricing.acceptableMaxAgeMs,
    },
    selectedModelId: decision.selectedModelId,
    selected: sel
      ? {
          expectedRequestCostUsd: sel.cost.estimatedRequestCost,
          retryPenaltyUsd: sel.cost.expectedRetryCost,
          escalationPenaltyUsd: sel.cost.expectedEscalationCost,
          latencyContributionUsd: sel.cost.latencyPenalty,
          expectedTotalCostUsd: sel.cost.expectedTotalCost,
        }
      : undefined,
    dealAffectedSelection: decision.dealAffectedSelection,
    pricingSnapshotAgeMs: decision.pricingSnapshotAgeMs,
    tieBreakRule: decision.tieBreakRule,
    overridesApplied: decision.overridesApplied,
    explanation: decision.explanation,
    confidenceLimitations: [
      "Costs are estimates derived from configured token priors, not observed token billing.",
      "Success-rate and latency priors come from local telemetry (or a neutral prior when " +
        "observations are below telemetry.minObservationsForPenalty) and are not guarantees " +
        "of future performance.",
      "Secret redaction of persisted output (src/telemetry/redact.ts) is a secondary, " +
        "pattern-matching defence, not a guarantee.",
      "Repository signals are derived only from tracked file names/paths (git ls-files); " +
        "file contents are never inspected.",
    ],
  };
}

program
  .command("explain")
  .argument("<task...>", "Task text")
  .option("--json", "JSON output (full §10.7 field set)")
  .option("--profile <profile>", "cheapest|balanced|frontier")
  .option("--model <id>", "Explicit model override")
  .option("--exclude-free", "Exclude free models")
  .option("--no-free", "Exclude free models (alias of --exclude-free)")
  .option("--max-estimated-cost <usd>", "Max expected cost")
  .action((taskParts: string[], opts) => {
    try {
      const { task, decision, loaded, repo } = decideCore(taskParts.join(" "), opts);
      if (opts.json) {
        console.log(JSON.stringify(buildExplainJson(task, decision, loaded.config, repo), null, 2));
      } else {
        console.log(formatExplain(task, decision, loaded.config));
      }
    } catch (e) {
      fail(e);
    }
  });

/** Requires --apply for --commit; a pure, standalone check so it can be unit-tested
 * without invoking the `run`/`orchestrate` actions (which this remediation wave must
 * never actually execute — see AGENTS ownership/safety rules). */
export function validateCommitFlag(opts: { commit?: boolean; apply?: boolean }): void {
  if (opts.commit && !opts.apply) {
    throw new CliUsageError(
      "--commit requires --apply (see §29: only an applied run has files to commit)",
    );
  }
}

/** `git status --porcelain` paths as a Set, used both by `ensureGitSafety`-adjacent
 * dirty-worktree detection and by `commitRunChanges` to snapshot the before/after file
 * sets around a run. */
export function gitStatusPaths(cwd: string): Set<string> {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", shell: false });
  const set = new Set<string>();
  if (r.status !== 0) return set;
  for (const line of (r.stdout || "").split("\n")) {
    const l = line.trim();
    if (!l) continue;
    // porcelain short format: "XY path" or "XY orig -> new" for renames.
    const path = l.slice(3).split(" -> ").pop();
    if (path) set.add(path.trim());
  }
  return set;
}

export interface CommitResult {
  committed: boolean;
  hash?: string;
  files?: string[];
  reason?: string;
}

/**
 * §29 `--commit`: commits ONLY files created or modified by this run, with a bounded
 * commit message, and returns the commit hash. Determines "files touched by this run" by
 * diffing `git status --porcelain` before vs. after the run — any path that was NOT
 * already dirty before the run is attributed to it; a path that was already dirty before
 * (only possible when the run used --allow-dirty) is left untouched/unstaged, since this
 * function cannot distinguish the run's further edits to an already-dirty file from the
 * pre-existing dirty state. NEVER pushes, force-pushes, or rewrites history — no such git
 * subcommand is invoked anywhere in this function.
 */
export function commitRunChanges(opts: {
  cwd: string;
  before: Set<string>;
  runId: string;
  taskSummary: string;
  modelId: string;
}): CommitResult {
  const after = gitStatusPaths(opts.cwd);
  const newFiles = [...after].filter((f) => !opts.before.has(f));
  if (newFiles.length === 0) {
    return { committed: false, reason: "no run-caused file changes detected" };
  }

  const addRes = spawnSync("git", ["add", "--", ...newFiles], {
    cwd: opts.cwd,
    encoding: "utf8",
    shell: false,
  });
  if (addRes.status !== 0) {
    return { committed: false, reason: `git add failed: ${addRes.stderr || addRes.stdout}` };
  }

  const boundedSummary = opts.taskSummary.slice(0, 72).replace(/\s+/g, " ").trim();
  const message = `ccroute: ${boundedSummary || "automated run"}\n\nrunId=${opts.runId} model=${opts.modelId}`;
  const commitRes = spawnSync("git", ["commit", "-m", message], {
    cwd: opts.cwd,
    encoding: "utf8",
    shell: false,
  });
  if (commitRes.status !== 0) {
    return {
      committed: false,
      reason: `git commit failed: ${commitRes.stderr || commitRes.stdout}`,
    };
  }

  const hashRes = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: opts.cwd,
    encoding: "utf8",
    shell: false,
  });
  return { committed: true, hash: (hashRes.stdout || "").trim(), files: newFiles };
}

export interface RunOpts {
  apply?: boolean;
  unsafeYolo?: boolean;
  maxTurns?: string;
  trustProject?: boolean;
  telemetry?: boolean;
  commit?: boolean;
}

/** Pure builder for the exact options object passed to `spawnCommandCode` — extracted so
 * the argv/flag-gating logic (autoAccept only with --apply, unsafeYolo requires BOTH
 * --unsafe-yolo AND --apply) can be unit-tested without spawning a real child process
 * (see AGENTS ownership/safety rules: `run` must never actually be invoked end-to-end in
 * this remediation wave's tests). */
export function buildRunSpawnOptions(params: {
  cmd: string;
  decision: RouteDecision;
  task: ClassifiedTask;
  config: RoutingConfig;
  opts: RunOpts;
  runId: string;
  cwd: string;
}): Parameters<typeof spawnCommandCode>[0] {
  const { cmd, decision, task, config, opts, runId, cwd } = params;
  return {
    cmdPath: cmd,
    model: decision.selectedModelId,
    stdinText: task.cleanedText,
    plan: false,
    autoAccept: Boolean(opts.apply),
    unsafeYolo: Boolean(opts.unsafeYolo) && Boolean(opts.apply),
    maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
    trust: Boolean(opts.trustProject),
    timeoutMs: config.security.defaultTimeoutMs,
    maxStdoutBytes: config.security.maxResultBytes,
    cwd,
    role: "executor",
    runId,
  };
}

/** Pure builder for `run`'s manifest.json content. */
export function buildRunManifest(
  runId: string,
  decision: RouteDecision,
  apply: boolean,
  res: { exitCode: number | null; timedOut: boolean; argv: string[] },
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    mode: "single",
    model: decision.selectedModelId,
    apply,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    argv: res.argv,
  };
}

/** Pure builder for the `run_start`/`override` telemetry event. */
export function buildRunStartEvent(runId: string, decision: RouteDecision, task: ClassifiedTask) {
  return {
    schemaVersion: 1 as const,
    ts: new Date().toISOString(),
    runId,
    event: decision.overridesApplied.length ? "override" : "run_start",
    modelId: decision.selectedModelId,
    taskClass: task.taskClass,
  };
}

/** Pure builder for the `run_end`/`timeout` telemetry event. */
export function buildRunEndEvent(
  runId: string,
  decision: RouteDecision,
  task: ClassifiedTask,
  res: { exitCode: number | null; timedOut: boolean; durationMs: number },
) {
  return {
    schemaVersion: 1 as const,
    ts: new Date().toISOString(),
    runId,
    event: res.timedOut ? "timeout" : "run_end",
    modelId: decision.selectedModelId,
    taskClass: task.taskClass,
    success: res.exitCode === 0 && !res.timedOut,
    latencyMs: res.durationMs,
    estimatedCostUsd: decision.candidates[0]?.cost.expectedTotalCost,
  };
}

program
  .command("run")
  .argument("<task...>", "Task text")
  .option("--apply", "Allow file writes (passes --auto-accept to cmd)")
  .option("--profile <profile>", "cheapest|balanced|frontier")
  .option("--model <id>", "Explicit model")
  .option("--exclude-free", "Exclude free models")
  .option("--no-free", "Exclude free models (alias)")
  .option("--max-estimated-cost <usd>", "Max cost")
  .option("--max-turns <n>", "Max turns")
  .option("--trust-project", "Pass --trust")
  .option("--unsafe-yolo", "Pass --yolo (dangerous)")
  .option("--no-telemetry", "Disable telemetry")
  .option("--allow-dirty", "Allow dirty worktree with --apply")
  .option("--commit", "Commit files created/modified by this run (requires --apply, see §29)")
  .action(async (taskParts: string[], opts) => {
    try {
      validateCommitFlag(opts);
      assertCcrouteEntryAllowed();
      if (opts.unsafeYolo) console.error(warnUnsafeYolo());
      const { task, decision, loaded, cmd } = decideCore(taskParts.join(" "), opts);
      if (!cmd) fail(new CmdNotFoundError());
      ensureGitSafety(Boolean(opts.apply), Boolean(opts.allowDirty), { context: "run" });

      const runId = randomUUID();
      const runsRoot = join(process.cwd(), ".commandcode", "deal-router", "runs");
      // A4: validate the run-artifact directory cannot escape its intended root before
      // any write happens (runId is always a fresh randomUUID with no path separators, so
      // this is defense-in-depth, not a fix for a reachable exploit today).
      const runDir = assertPathInsideRoot(runId, runsRoot);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "decision.json"), JSON.stringify(decision, null, 2));
      writeFileSync(join(runDir, "task.json"), JSON.stringify(task, null, 2));

      console.error(
        `Route: ${decision.selectedModelId} (${decision.taskClass}/${decision.profile})`,
      );
      if (!opts.apply) console.error("Read-only run (no --apply).");

      const tel = opts.telemetry !== false && loaded.config.telemetry.enabled;
      if (tel) {
        appendTelemetry(loaded.config.telemetry.path, buildRunStartEvent(runId, decision, task));
      }

      const before = opts.commit ? gitStatusPaths(process.cwd()) : undefined;

      const res = await spawnCommandCode(
        buildRunSpawnOptions({
          cmd: cmd!,
          decision,
          task,
          config: loaded.config,
          opts,
          runId,
          cwd: process.cwd(),
        }),
      );

      // A4: redact before persisting — raw child stdout may echo secret-shaped content
      // (see src/telemetry/redact.ts's documented limitations: this is a secondary
      // defence, not a guarantee).
      writeFileSync(join(runDir, "executor-raw.txt"), redactText(res.stdout), "utf8");
      writeFileSync(
        join(runDir, "manifest.json"),
        JSON.stringify(buildRunManifest(runId, decision, Boolean(opts.apply), res), null, 2),
      );

      if (opts.commit) {
        const commitResult = commitRunChanges({
          cwd: process.cwd(),
          before: before ?? new Set(),
          runId,
          taskSummary: task.cleanedText,
          modelId: decision.selectedModelId,
        });
        writeFileSync(join(runDir, "commit.json"), JSON.stringify(commitResult, null, 2));
        console.error(
          commitResult.committed
            ? `Committed ${commitResult.files?.length ?? 0} file(s) as ${commitResult.hash}`
            : `No commit created: ${commitResult.reason}`,
        );
      }

      if (tel) {
        appendTelemetry(loaded.config.telemetry.path, buildRunEndEvent(runId, decision, task, res));
      }

      process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(res.exitCode ?? EXIT.SUBPROCESS_FAILURE);
    } catch (e) {
      fail(e);
    }
  });

export interface OrchestrateOpts {
  apply?: boolean;
  model?: string;
  plannerModel?: string;
  advisorModel?: string;
  executorModel?: string;
  reviewerModel?: string;
  noPlanner?: boolean;
  noAdvisor?: boolean;
  noReviewer?: boolean;
  maxTurns?: string;
  maxPlanRevisions?: string;
  maxRepairs?: string;
  trustProject?: boolean;
  unsafeYolo?: boolean;
  telemetry?: boolean;
  skipValidation?: boolean;
  commit?: boolean;
}

/**
 * A3: pure builder for the effective `RoutingConfig` used by `orchestrate` — applies
 * `--max-plan-revisions`/`--max-repairs` CLI overrides on top of the loaded config's
 * `orchestration.maxPlannerRevisions`/`maxRepairs`. Extracted so this override logic is
 * unit-testable without invoking the `orchestrate` command end-to-end.
 */
export function buildEffectiveOrchestrationConfig(
  config: RoutingConfig,
  opts: Pick<OrchestrateOpts, "maxPlanRevisions" | "maxRepairs">,
): RoutingConfig {
  return {
    ...config,
    orchestration: {
      ...config.orchestration,
      maxPlannerRevisions:
        opts.maxPlanRevisions !== undefined
          ? Number(opts.maxPlanRevisions)
          : config.orchestration.maxPlannerRevisions,
      maxRepairs:
        opts.maxRepairs !== undefined ? Number(opts.maxRepairs) : config.orchestration.maxRepairs,
    },
  };
}

/**
 * A3: pure builder for the full `OrchestrateOptions` object passed to `orchestrate()` —
 * this is where `--skip-validation` becomes `flags.skipValidation` and the config's
 * `validation` block becomes `validationGate`. Extracted so this wiring is unit-testable
 * without ever invoking `orchestrate()` for real (see AGENTS ownership/safety rules:
 * `orchestrate` must never actually be run end-to-end in this remediation wave's tests).
 */
export function buildOrchestrateOptions(params: {
  cmd: string;
  effectiveConfig: RoutingConfig;
  task: ClassifiedTask;
  decision: RouteDecision;
  opts: OrchestrateOpts;
  cwd: string;
  runDir: string;
}): Parameters<typeof orchestrate>[0] {
  const { cmd, effectiveConfig, task, decision, opts, cwd, runDir } = params;
  return {
    cmdPath: cmd,
    config: effectiveConfig,
    task,
    decision,
    apply: Boolean(opts.apply),
    unsafeYolo: Boolean(opts.unsafeYolo),
    trust: Boolean(opts.trustProject),
    cwd,
    runDir,
    telemetryPath: effectiveConfig.telemetry.path,
    telemetryEnabled: opts.telemetry !== false && effectiveConfig.telemetry.enabled,
    models: {
      planner: opts.plannerModel,
      advisor: opts.advisorModel,
      executor: opts.executorModel ?? opts.model,
      reviewer: opts.reviewerModel,
    },
    flags: {
      noPlanner: Boolean(opts.noPlanner),
      noAdvisor: Boolean(opts.noAdvisor),
      noReviewer: Boolean(opts.noReviewer),
      maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
      skipValidation: Boolean(opts.skipValidation),
    },
    validationGate: effectiveConfig.validation,
  };
}

program
  .command("orchestrate")
  .argument("<task...>", "Task text")
  .option("--apply", "Allow writes")
  .option("--profile <profile>", "profile")
  .option("--model <id>", "Default model")
  .option("--planner-model <id>", "Planner model")
  .option("--advisor-model <id>", "Advisor model")
  .option("--executor-model <id>", "Executor model")
  .option("--reviewer-model <id>", "Reviewer model")
  .option("--no-planner", "Skip planner")
  .option("--no-advisor", "Skip advisor")
  .option("--no-reviewer", "Skip reviewer")
  .option("--max-estimated-cost <usd>", "Max cost")
  .option("--max-turns <n>", "Max turns override")
  .option("--max-plan-revisions <n>", "Override orchestration.maxPlannerRevisions")
  .option("--max-repairs <n>", "Override orchestration.maxRepairs")
  .option("--allow-dirty", "Allow dirty worktree with --apply")
  .option("--trust-project", "Pass --trust")
  .option("--unsafe-yolo", "Dangerous yolo")
  .option("--no-telemetry", "Disable telemetry")
  .option("--force", "Orchestrate even for trivial tasks")
  .option(
    "--skip-validation",
    "Skip the deterministic validation gate (§24.5) — must be explicit, never a side effect",
  )
  .option("--commit", "Commit files created/modified by this run (requires --apply, see §29)")
  .action(async (taskParts: string[], opts) => {
    try {
      validateCommitFlag(opts);
      assertCcrouteEntryAllowed();
      if (opts.unsafeYolo) console.error(warnUnsafeYolo());
      const { task, decision, loaded, cmd } = decideCore(taskParts.join(" "), opts);
      if (!cmd) fail(new CmdNotFoundError());
      if (!opts.force && !shouldOrchestrate(task, loaded.config)) {
        console.error(
          `Task class ${task.taskClass} does not justify multi-role orchestration; use ccroute run (or --force).`,
        );
        process.exit(EXIT.INVALID_CLI_USAGE);
      }
      ensureGitSafety(Boolean(opts.apply), Boolean(opts.allowDirty), { context: "orchestrate" });

      const runId = randomUUID();
      const runsRoot = join(process.cwd(), ".commandcode", "deal-router", "runs");
      const runDir = assertPathInsideRoot(runId, runsRoot);
      console.error(
        `Orchestrate route default=${decision.selectedModelId} class=${task.taskClass}`,
      );

      // A3: wire the config's `validation` block + `--skip-validation` through to the
      // orchestrator's deterministic validation gate (§24.5). Previously this gate always
      // ran with hardcoded defaults regardless of configuration, and --skip-validation did
      // not exist as a flag at all.
      const effectiveConfig = buildEffectiveOrchestrationConfig(loaded.config, opts);
      const before = opts.commit ? gitStatusPaths(process.cwd()) : undefined;

      const result = await orchestrate(
        buildOrchestrateOptions({
          cmd: cmd!,
          effectiveConfig,
          task,
          decision,
          opts,
          cwd: process.cwd(),
          runDir,
        }),
      );

      if (opts.commit) {
        const commitResult = commitRunChanges({
          cwd: process.cwd(),
          before: before ?? new Set(),
          runId: result.runId,
          taskSummary: task.cleanedText,
          modelId: decision.selectedModelId,
        });
        writeFileSync(join(runDir, "commit.json"), JSON.stringify(commitResult, null, 2));
        console.error(
          commitResult.committed
            ? `Committed ${commitResult.files?.length ?? 0} file(s) as ${commitResult.hash}`
            : `No commit created: ${commitResult.reason}`,
        );
      }

      console.log(
        JSON.stringify(
          { runId: result.runId, summary: result.summary, roles: Object.keys(result.roles) },
          null,
          2,
        ),
      );
      console.error(`Artifacts: ${runDir}`);
      process.exit(mapOrchestrateExit(result.exitCode, result.blockedReason));
    } catch (e) {
      fail(e);
    }
  });

program
  .command("stats")
  .option("--model <id>", "Filter model")
  .option("--task-class <class>", "Filter task class")
  .option("--since <date>", "Only include telemetry events at/after this ISO date/time")
  .action((opts) => {
    try {
      const loaded = loadRuntime();
      let events = readTelemetryEvents(loaded.config.telemetry.path);
      if (opts.since) {
        const sinceMs = Date.parse(opts.since);
        if (Number.isNaN(sinceMs)) {
          throw new CliUsageError(`--since: not a valid date/time: ${opts.since}`);
        }
        events = events.filter((e) => {
          const t = Date.parse(e.ts);
          return !Number.isNaN(t) && t >= sinceMs;
        });
      }
      const by = aggregateByModel(events);
      console.log(formatStats(by, { modelId: opts.model, taskClass: opts.taskClass }, events));
    } catch (e) {
      fail(e);
    }
  });

const runs = program.command("runs").description("Inspect past run artifacts");
runs.command("list").action(() => {
  const base = join(process.cwd(), ".commandcode", "deal-router", "runs");
  if (!existsSync(base)) {
    console.log("(no runs)");
    return;
  }
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  if (!dirs.length) {
    console.log("(no runs)");
    return;
  }
  for (const id of dirs) {
    const mp = join(base, id, "manifest.json");
    if (!existsSync(mp)) {
      console.log(`${id}  (no manifest)`);
      continue;
    }
    try {
      const m: Record<string, unknown> = JSON.parse(readFileSync(mp, "utf8"));
      const model = String(m.model ?? "?");
      const mode = String(m.mode ?? "?");
      const exitCode = m.exitCode !== undefined ? ` exit=${m.exitCode}` : "";
      const dp = join(base, id, "decision.json");
      let cls = "";
      if (existsSync(dp)) {
        try {
          const d: Record<string, unknown> = JSON.parse(readFileSync(dp, "utf8"));
          if (d.taskClass) cls = ` ${String(d.taskClass)}`;
        } catch {
          /* ignore parse errors */
        }
      }
      console.log(`${id.slice(0, 8)}  model=${model}${cls}${exitCode} mode=${mode}`);
    } catch {
      console.log(`${id.slice(0, 8)}  (corrupt manifest)`);
    }
  }
});
runs
  .command("show")
  .argument("<id>", "Run id prefix or full id")
  .option("--json", "JSON output")
  .action((id: string, opts) => {
    const base = join(process.cwd(), ".commandcode", "deal-router", "runs");
    if (!existsSync(base)) {
      fail(new Error(`Runs directory not found: ${base}`));
      return;
    }
    let runDir: string | undefined;
    const dirs = readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    runDir = dirs.find((d) => d === id || d.startsWith(id));
    if (!runDir) {
      fail(new Error(`Run not found: ${id}`));
      return;
    }
    const dir = join(base, runDir);
    const files = readdirSync(dir);
    const mp = join(dir, "manifest.json");
    if (!existsSync(mp)) {
      console.log(JSON.stringify({ runId: runDir, files }, null, 2));
      return;
    }
    const m: Record<string, unknown> = JSON.parse(readFileSync(mp, "utf8"));
    const result: Record<string, unknown> = { ...m, files };
    const dp = join(dir, "decision.json");
    if (existsSync(dp)) {
      try {
        const d: Record<string, unknown> = JSON.parse(readFileSync(dp, "utf8"));
        result.taskClass = d.taskClass;
        result.profile = d.profile;
        result.overrides = d.overridesApplied;
        const cands = d.candidates;
        result.candidates = Array.isArray(cands) ? cands.length : undefined;
      } catch {
        /* ignore */
      }
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Run: ${runDir}`);
      console.log(`  Model: ${m.model ?? "?"}`);
      console.log(`  Mode: ${m.mode ?? "?"}`);
      console.log(`  Apply: ${Boolean(m.apply)}`);
      console.log(`  Exit code: ${m.exitCode ?? "?"}`);
      console.log(`  Timed out: ${Boolean(m.timedOut)}`);
      console.log(`  Task class: ${result.taskClass ?? "?"}`);
      console.log(`  Profile: ${result.profile ?? "?"}`);
      console.log(`  Artifacts: ${files.join(", ")}`);
    }
  });

/**
 * §29 doctor health status. BLOCKED means ccroute cannot route at all (no `cmd`
 * executable found); DEGRADED means it can route but something is worth the operator's
 * attention (auth, expired deals, stale pricing, dirty worktree, capability-probe
 * contradictions); HEALTHY means none of the above.
 */
export type DoctorHealthStatus = "HEALTHY" | "DEGRADED" | "BLOCKED";

export function computeDoctorHealth(input: {
  cmdFound: boolean;
  authenticated: boolean | null;
  expiredDeals: string[];
  contradictions: string[];
  pricingStale: boolean;
  dirtyWorktree: boolean;
}): { status: DoctorHealthStatus; warnings: string[] } {
  if (!input.cmdFound) {
    return {
      status: "BLOCKED",
      warnings: ["CommandCode `cmd` executable not found on PATH; ccroute cannot route"],
    };
  }
  const warnings: string[] = [];
  if (input.authenticated === false) warnings.push("CommandCode reports not authenticated");
  if (input.expiredDeals.length > 0) {
    warnings.push(
      `expired deals still present in pricing snapshot: ${input.expiredDeals.join(", ")}`,
    );
  }
  if (input.contradictions.length > 0) warnings.push(...input.contradictions);
  if (input.pricingStale) {
    warnings.push("pricing snapshot is stale (older than the configured acceptable threshold)");
  }
  if (input.dirtyWorktree) warnings.push("repository worktree is dirty");
  return { status: warnings.length > 0 ? "DEGRADED" : "HEALTHY", warnings };
}

/** Doctor's own health-status exit code. Distinct from the typed-error taxonomy in
 * exit-codes.ts (which governs `fail()`): doctor never throws these, it reports a direct
 * health signal.
 *
 * DEGRADED exits 0 deliberately. It means "ccroute can route, but something is worth
 * your attention" — warnings, not failures. Two reasons not to use a non-zero code:
 * §11 gives no code for an informational state and forbids reusing 1, and a dirty
 * worktree is a DEGRADED warning, so a non-zero exit would make `doctor` fail during
 * ordinary development and in any CI step that runs it. Callers that need to act on
 * degradation read `healthStatus` / `warnings` from `doctor --json`, which is precise;
 * an exit code cannot carry which warning fired. BLOCKED reuses CAPABILITY_MISMATCH
 * (20) because "no local `cmd` capability" is exactly that, and it is a real failure:
 * ccroute cannot route at all. */
const DOCTOR_EXIT_CODE: Record<DoctorHealthStatus, number> = {
  HEALTHY: EXIT.SUCCESS,
  DEGRADED: EXIT.SUCCESS,
  BLOCKED: EXIT.CAPABILITY_MISMATCH,
};

program
  .command("doctor")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      assertCcrouteEntryAllowed();
      const loaded = loadRuntime();
      const caps = probeCapabilities(loaded.config.cmdPath);
      const pricing = loadPricingSnapshot();
      const deals = loadDealSnapshot();
      const now = Date.now();
      const expiredDeals = pricing.models
        .filter(
          (m) =>
            m.availability === "expired_deal" ||
            (m.deal?.expiresAt && Date.parse(m.deal.expiresAt) <= now),
        )
        .map((m) => m.id);

      const pricingAgeMs = snapshotAgeMs(pricing.retrievedAt, now);
      const pricingFreshness = classifySnapshotFreshness(pricingAgeMs, {
        freshMaxAgeMs: loaded.config.pricing.freshMaxAgeMs,
        acceptableMaxAgeMs: loaded.config.pricing.acceptableMaxAgeMs,
      });
      const repoStatus = defaultGitPorcelainStatus();
      const isGitRepo = repoStatus.status === 0;
      const dirtyWorktree = isGitRepo && repoStatus.stdout.trim().length > 0;

      const { status: healthStatus, warnings } = computeDoctorHealth({
        cmdFound: Boolean(caps.cmd.path),
        authenticated: caps.status?.authenticated ?? null,
        expiredDeals,
        contradictions: caps.contradictions,
        pricingStale: pricingFreshness === "stale",
        dirtyWorktree,
      });

      const report = {
        ccrouteVersion: CCROUTE_VERSION,
        nodeVersion: process.version,
        cmdPath: caps.cmd.path,
        commandCodeVersion: caps.cmd.version,
        authenticated: caps.status?.authenticated ?? null,
        user: caps.status?.user ?? null,
        availableModelCount: caps.modelIds.length,
        availableModelIds: caps.modelIds,
        configFiles: loaded.sources,
        pricingSnapshotPath: pricingSnapshotPath(),
        pricingSnapshotAgeMs: pricingAgeMs,
        pricingSnapshotFreshness: pricingFreshness,
        dealSnapshotPath: dealsSnapshotPath(),
        dealSnapshotAgeMs: snapshotAgeMs(deals.retrievedAt, now),
        expiredDeals,
        writePermissionPolicy: "writes require explicit --apply; --auto-accept only then",
        telemetryPath: loaded.config.telemetry.path,
        recursiveInvocation: process.env.CCROUTE_CHILD === "1",
        unsupportedAssumptions: caps.contradictions,
        supportedFlags: caps.supportedFlags,
        repository: { isGitRepo, dirty: dirtyWorktree },
        warnings,
        healthStatus,
      };

      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log("ccroute doctor");
        console.log(`  ccroute version: ${report.ccrouteVersion}`);
        console.log(`  Node: ${report.nodeVersion}`);
        console.log(`  cmd: ${report.cmdPath ?? "(missing)"}`);
        console.log(`  CommandCode: ${report.commandCodeVersion ?? "(unknown)"}`);
        console.log(`  Auth: ${report.authenticated}`);
        console.log(`  Models: ${report.availableModelCount}`);
        console.log(`  Config: ${report.configFiles.join(" | ")}`);
        console.log(
          `  Pricing snapshot: ${report.pricingSnapshotPath} ` +
            `(age ${Math.round(report.pricingSnapshotAgeMs / 1000)}s, ${report.pricingSnapshotFreshness})`,
        );
        console.log(`  Deal snapshot: ${report.dealSnapshotPath}`);
        console.log(`  Expired deals: ${expiredDeals.join(", ") || "(none)"}`);
        console.log(
          `  Repository: ${isGitRepo ? (dirtyWorktree ? "dirty" : "clean") : "(not a git repo)"}`,
        );
        console.log(`  Telemetry: ${report.telemetryPath}`);
        console.log(`  Write policy: ${report.writePermissionPolicy}`);
        if (report.unsupportedAssumptions.length) {
          console.log(`  Contradictions: ${report.unsupportedAssumptions.join("; ")}`);
        }
        console.log(`  Warnings: ${warnings.length ? warnings.join("; ") : "(none)"}`);
        console.log(`  Health: ${healthStatus}`);
      }
      process.exit(DOCTOR_EXIT_CODE[healthStatus]);
    } catch (e) {
      fail(e);
    }
  });

const models = program.command("models").description("Model catalog");
models
  .command("list")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const loaded = loadRuntime();
      const cmd = resolveCmdPath(loaded.config.cmdPath);
      if (!cmd) fail(new CmdNotFoundError());
      const live = fetchLiveModelIds(cmd!);
      if (live.error) fail(new Error(live.error));
      if (opts.json) console.log(JSON.stringify(live.ids, null, 2));
      else for (const id of live.ids) console.log(id);
    } catch (e) {
      fail(e);
    }
  });
models
  .command("status")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const loaded = loadRuntime();
      const cmd = resolveCmdPath(loaded.config.cmdPath);
      const pricing = loadPricingSnapshot();
      const live = cmd ? fetchLiveModelIds(cmd) : { ids: [] as string[], error: "cmd not found" };
      const liveIds = new Set(live.ids);
      const report = {
        pricingRetrievedAt: pricing.retrievedAt,
        pricingSource: pricing.source,
        cmdPath: cmd,
        liveCatalogAvailable: Boolean(cmd) && live.ids.length > 0,
        liveCatalogError: live.error,
        liveModelCount: live.ids.length,
        models: pricing.models.map((m) => ({
          id: m.id,
          availability: m.availability,
          qualityTier: m.qualityTier,
          deal: m.deal?.label,
          inLiveCatalog: liveIds.has(m.id),
        })),
      };
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(
          `Pricing retrieved: ${report.pricingRetrievedAt} source=${report.pricingSource}`,
        );
        console.log(`cmd: ${report.cmdPath ?? "(not found)"}`);
        console.log(
          `Live catalog: ${
            report.liveCatalogAvailable
              ? `${report.liveModelCount} models`
              : `unavailable${report.liveCatalogError ? ` (${report.liveCatalogError})` : ""}`
          }`,
        );
        for (const m of report.models) {
          console.log(
            `  ${m.id}: ${m.availability} tier=${m.qualityTier}${m.deal ? ` deal=${m.deal}` : ""}${
              m.inLiveCatalog ? "" : " [not in live catalog]"
            }`,
          );
        }
      }
    } catch (e) {
      fail(e);
    }
  });
models
  .command("bootstrap")
  .description("Install bundled seed pricing only if no valid snapshot exists")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const r = bootstrapPricingSnapshot();
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(r.reason);
        console.log(
          `claimsFreshness=${r.claimsFreshness} wrote=${r.wrote} retrievedAt=${r.snapshotRetrievedAt ?? "n/a"}`,
        );
      }
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

models
  .command("refresh")
  .description("Refresh model availability from live catalog (coordinated lease)")
  .option("--force", "Bypass backoff", false)
  .option("--break-stale-lease", "Take over only if lease is proven stale", false)
  .option("--json", "JSON output", false)
  .action(async (opts) => {
    try {
      // models refresh does not require --config for catalog merge, but still honors it
      // for cmdPath when provided via loadRuntime side effects... keep fail-closed on
      // explicit invalid --config by probing loadRuntime first.
      loadRuntime();
      const result = await runCoordinatedRefresh({
        allowNetwork: false,
        // Operator-initiated live catalog refresh bypasses backoff by default;
        // --force is accepted as an explicit alias.
        force: true,
        breakStaleLease: Boolean(opts.breakStaleLease),
        mode: "models-live",
        skipModelsLive: false,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          result.skipped
            ? `Skipped: ${result.reason}`
            : result.ok
              ? "Refreshed model identities from live catalog"
              : `Refresh failed: ${result.error ?? result.reason}`,
        );
      }
      if (!result.ok) process.exit(EXIT.SUBPROCESS_FAILURE);
    } catch (e) {
      fail(e);
    }
  });

const dealsCmd = program.command("deals").description("Deal snapshots");
dealsCmd
  .command("list")
  .option("--json", "JSON output")
  .action((opts) => {
    const d = loadDealSnapshot();
    if (opts.json) {
      console.log(JSON.stringify(d.deals, null, 2));
      return;
    }
    for (const deal of d.deals) {
      console.log(
        `${deal.modelId}\t${deal.type}\t${deal.label}\texpires=${deal.expiresAt ?? "never"}`,
      );
    }
  });
dealsCmd.command("status").action(() => {
  const d = loadDealSnapshot();
  const p = loadPricingSnapshot();
  console.log(`Deals retrieved: ${d.retrievedAt} source=${d.source}`);
  console.log(`Pricing retrieved: ${p.retrievedAt} source=${p.source}`);
  const ageP = snapshotAgeMs(p.retrievedAt);
  const freshness = classifySnapshotFreshness(ageP);
  console.log(`Pricing freshness: ${freshness} (ageMs=${ageP})`);
  console.log("(Bootstrap never claims freshness; seed retrievedAt is historical.)");
  const now = Date.now();
  for (const deal of d.deals) {
    const exp = deal.expiresAt ? Date.parse(deal.expiresAt) <= now : false;
    console.log(`  ${deal.modelId}: ${exp ? "EXPIRED" : "active"} (${deal.label})`);
  }
});
dealsCmd
  .command("bootstrap")
  .description("Install bundled seed deals only if no valid snapshot exists")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const r = bootstrapDealSnapshot();
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(r.reason);
        console.log(
          `claimsFreshness=${r.claimsFreshness} wrote=${r.wrote} retrievedAt=${r.snapshotRetrievedAt ?? "n/a"}`,
        );
      }
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });
dealsCmd
  .command("refresh")
  .description("Refresh deals+pricing from official source (coordinated lease)")
  .option("--network", "Fetch official pricing-limits page (default for coordinated path)", true)
  .option("--force", "Bypass backoff", false)
  .option("--break-stale-lease", "Take over only if lease is proven stale", false)
  .option("--json", "JSON output", false)
  .action(async (opts) => {
    try {
      // Offline re-seed is no longer a refresh: point operators at bootstrap
      if (opts.network === false) {
        console.error(
          "Offline re-seed is not a refresh. Use `ccroute deals bootstrap` / `ccroute models bootstrap`.",
        );
        process.exit(EXIT.INVALID_CLI_USAGE);
      }
      const result = await runCoordinatedRefresh({
        allowNetwork: true,
        force: opts.force,
        breakStaleLease: opts.breakStaleLease,
        mode: "network",
        fetchImpl: globalThis.fetch,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.skipped) console.log(`Skipped: ${result.reason}`);
      else if (result.ok) console.log("Deals+pricing refresh complete (atomic snapshots).");
      else console.error(result.error ?? result.reason);
      process.exit(result.ok ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

// ── Coordinated refresh / launchd ─────────────────────────────────────────
const refreshCmd = program.command("refresh").description("Coordinated pricing refresh automation");

refreshCmd
  .command("status")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const st = getRefreshStatus();
      const launchd = statusLaunchd();
      const report = {
        refresh: st,
        launchd: {
          label: launchd.label,
          plistPath: launchd.plistPath,
          installed: launchd.installed,
          loaded: launchd.loaded,
          messages: launchd.messages,
        },
      };
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`lastSuccess=${st.state.lastSuccessAt ?? "never"}`);
        console.log(`lastError=${st.state.lastError ?? "none"}`);
        console.log(`failureCount=${st.state.failureCount}`);
        console.log(
          `backoff=${st.backoff.active ? `until ${st.backoff.nextEligibleAt}` : "inactive"}`,
        );
        console.log(
          `lease=${st.state.activeLease ? `${st.state.activeLease.ownerInstance} stale=${st.leaseStale}` : "none"}`,
        );
        console.log(
          `launchd: installed=${launchd.installed} loaded=${launchd.loaded} (${launchd.label})`,
        );
      }
    } catch (e) {
      fail(e);
    }
  });

refreshCmd
  .command("run")
  .description("Run one coordinated refresh (used by launchd and session-start)")
  .option("--force", "Bypass backoff", false)
  .option("--break-stale-lease", "Break only if lease is stale", false)
  .option("--scheduled", "Mark mode as scheduled", false)
  .option("--session-start", "Mark mode as session-start", false)
  .option("--json", "JSON output", false)
  .action(async (opts) => {
    try {
      const mode = opts.sessionStart ? "session-start" : opts.scheduled ? "scheduled" : "network";
      const result = await runCoordinatedRefresh({
        allowNetwork: true,
        force: opts.force,
        breakStaleLease: opts.breakStaleLease,
        mode,
        fetchImpl: globalThis.fetch,
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else if (result.skipped) console.log(`Skipped: ${result.reason}`);
      else if (result.ok) console.log("Refresh run complete");
      else console.error(result.error ?? result.reason);
      // Skipped lease contention is success (concurrency path)
      process.exit(result.ok ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

refreshCmd
  .command("install")
  .description("Install macOS launchd agent for daily refresh")
  .option("--hour <n>", "Local hour for calendar schedule", "4")
  .option("--minute <n>", "Local minute", "0")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const ccroutePath = resolveCcrouteAbsolute();
      if (!ccroutePath) {
        fail(
          new CliUsageError(
            "Cannot resolve absolute ccroute path; install via npm link or pass a known bin",
          ),
        );
      }
      // Ensure seeds exist without claiming freshness
      bootstrapBoth();
      const r = installLaunchd({
        ccroutePath: ccroutePath!,
        hour: Number(opts.hour),
        minute: Number(opts.minute),
      });
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const m of r.messages) console.log(m);
        if (r.error) console.error(r.error);
      }
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

refreshCmd
  .command("uninstall")
  .description("Unload and remove macOS launchd agent")
  .option("--json", "JSON output")
  .action((opts) => {
    try {
      const r = uninstallLaunchd();
      if (opts.json) console.log(JSON.stringify(r, null, 2));
      else for (const m of r.messages) console.log(m);
      process.exit(r.ok ? 0 : 1);
    } catch (e) {
      fail(e);
    }
  });

const configCmd = program.command("config").description("Configuration");
configCmd
  .command("show")
  .option("--json", "JSON output (full merged configuration)")
  .action((opts) => {
    try {
      const loaded = loadRuntime();
      if (opts.json) {
        console.log(JSON.stringify(loaded.config, null, 2));
        return;
      }
      console.log("ccroute config");
      console.log(`  defaultProfile: ${loaded.config.defaultProfile}`);
      console.log(`  cmdPath: ${loaded.config.cmdPath ?? "(auto-detect via PATH)"}`);
      console.log(
        `  telemetry: enabled=${loaded.config.telemetry.enabled} path=${loaded.config.telemetry.path}`,
      );
      console.log(
        `  validation: enabled=${loaded.config.validation.enabled} ` +
          `commands=${loaded.config.validation.commands.map((c) => c.name).join(",")}`,
      );
      console.log(`  sources: ${loaded.sources.join(" | ")}`);
      console.log("  (use --json for the full merged configuration)");
    } catch (e) {
      fail(e);
    }
  });
configCmd.command("paths").action(() => {
  console.log(`user: ${userConfigPath()}`);
  console.log(`project: ${projectConfigPath()}`);
  console.log(`state: ${stateDir()}`);
  console.log("defaults: config/routing.default.yaml (package)");
});
configCmd.command("validate").action(() => {
  const paths = [userConfigPath(), projectConfigPath()].filter(Boolean);
  let ok = true;
  for (const p of paths) {
    const r = validateConfigFile(p);
    if (r.ok) console.log(`OK ${p}`);
    else if (r.error.startsWith("File not found")) console.log(`missing ${p}`);
    else {
      ok = false;
      console.error(`INVALID ${p}: ${r.error}`);
    }
  }
  // always validate defaults merge
  try {
    loadRuntime();
    console.log("OK merged configuration");
  } catch (e) {
    ok = false;
    console.error((e as Error).message);
  }
  process.exit(ok ? 0 : 1);
});

/**
 * Managed CommandCode installation lifecycle (TP-CCROUTE-AUTO-002).
 * Uses official `cmd mods` for Mod registration; never clobbers unrelated settings.
 */
function parseInstallScopeOpts(opts: {
  project?: boolean;
  user?: boolean;
  dryRun?: boolean;
  force?: boolean;
  skill?: boolean;
  hooks?: boolean;
  installMemory?: boolean;
  json?: boolean;
}): InstallCliOptions {
  if (opts.project && opts.user) {
    throw new CliUsageError("Reject simultaneous --project and --user; choose exactly one scope");
  }
  return {
    project: opts.project,
    user: opts.user,
    dryRun: opts.dryRun,
    force: opts.force,
    skill: opts.skill,
    hooks: opts.hooks,
    installMemory: opts.installMemory,
    json: opts.json,
  };
}

function finishLifecycle(
  result: ReturnType<typeof installLifecycle>,
  json: boolean | undefined,
): void {
  console.log(formatLifecycleResult(result, Boolean(json)));
  if (result.ok) process.exit(EXIT.SUCCESS);
  if (result.exitHint === "usage") process.exit(EXIT.INVALID_CLI_USAGE);
  if (result.exitHint === "conflict") process.exit(EXIT.REPOSITORY_SAFETY_VIOLATION);
  if (result.exitHint === "subprocess") process.exit(EXIT.SUBPROCESS_FAILURE);
  if (result.exitHint === "config") process.exit(EXIT.CONFIG_INVALID);
  process.exit(EXIT.INTERNAL_INVARIANT_FAILURE);
}

const installCmd = program
  .command("install")
  .description("Install ccroute into CommandCode (Mod + optional skill/hooks)")
  .option("--project", "Project-scope install (default)", false)
  .option("--user", "User-scope install (explicit global)", false)
  .option("--dry-run", "Preview actions without writing", false)
  .option("--force", "Override conflicts on owned artifacts", false)
  .option("--skill", "Also install the deal-orchestrator skill", false)
  .option("--hooks", "Also install fallback security hooks", false)
  .option("--install-memory", "Reserved; no-op until TP4 memory artifacts exist", false)
  .option("--json", "JSON result", false)
  .action((opts) => {
    try {
      const parsed = parseInstallScopeOpts(opts);
      // Default scope is project when neither flag is set
      if (!parsed.user) parsed.project = true;
      finishLifecycle(installLifecycle(parsed), opts.json);
    } catch (e) {
      if (e instanceof InstallError) fail(e);
      fail(e);
    }
  });

installCmd
  .command("status")
  .description("Show managed installation status")
  .option("--project", "Project scope (default)", false)
  .option("--user", "User scope", false)
  .option("--json", "JSON result", false)
  .action((opts) => {
    try {
      const parsed = parseInstallScopeOpts(opts);
      if (!parsed.user) parsed.project = true;
      finishLifecycle(statusLifecycle(parsed), opts.json);
    } catch (e) {
      fail(e);
    }
  });

installCmd
  .command("update")
  .description("Update managed installation")
  .option("--project", "Project scope (default)", false)
  .option("--user", "User scope", false)
  .option("--dry-run", "Preview only", false)
  .option("--force", "Override conflicts", false)
  .option("--json", "JSON result", false)
  .action((opts) => {
    try {
      const parsed = parseInstallScopeOpts(opts);
      if (!parsed.user) parsed.project = true;
      finishLifecycle(updateLifecycle(parsed), opts.json);
    } catch (e) {
      fail(e);
    }
  });

installCmd
  .command("repair")
  .description("Repair missing or drifted managed installation state")
  .option("--project", "Project scope (default)", false)
  .option("--user", "User scope", false)
  .option("--dry-run", "Preview only", false)
  .option("--force", "Overwrite user-modified owned files", false)
  .option("--json", "JSON result", false)
  .action((opts) => {
    try {
      const parsed = parseInstallScopeOpts(opts);
      if (!parsed.user) parsed.project = true;
      finishLifecycle(repairLifecycle(parsed), opts.json);
    } catch (e) {
      fail(e);
    }
  });

program
  .command("uninstall")
  .description("Remove managed ccroute installation (owned artifacts only)")
  .option("--project", "Project scope (default)", false)
  .option("--user", "User scope", false)
  .option("--dry-run", "Preview only", false)
  .option("--force", "Continue past non-blocking conflicts", false)
  .option("--json", "JSON result", false)
  .action((opts) => {
    try {
      const parsed = parseInstallScopeOpts(opts);
      if (!parsed.user) parsed.project = true;
      finishLifecycle(uninstallLifecycle(parsed), opts.json);
    } catch (e) {
      fail(e);
    }
  });

/** True when this module is being executed directly (`node dist/cli.js ...` / the `ccroute`
 * bin), false when imported (e.g. from a test importing `{ program }`). Guards the
 * top-level `parseAsync` call below so importing cli.ts for in-process testing never
 * triggers a real argv parse against the test runner's own process.argv. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

export async function runCli(argv: string[]): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === "commander.helpDisplayed" || e.code === "commander.version") {
        process.exit(EXIT.SUCCESS);
      }
      // Commander already wrote its own "error: ..." message via configureOutput/error()
      // before invoking the exitOverride callback; do not print it twice.
      process.exit(EXIT.INVALID_CLI_USAGE);
    }
    fail(e);
  }
}

if (isMainModule()) {
  void runCli(process.argv);
}

export { program };
