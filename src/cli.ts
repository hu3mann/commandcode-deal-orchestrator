#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { classifyTask } from "./classifier/deterministic.js";
import {
  loadConfig,
  projectConfigPath,
  stateDir,
  userConfigPath,
  validateConfigFile,
} from "./config/loader.js";
import { ConfigError } from "./config/merge.js";
import { probeCapabilities } from "./discovery/capability-probe.js";
import { resolveCmdPath } from "./discovery/commandcode-cli.js";
import { fetchLiveModelIds } from "./discovery/model-catalog.js";
import type { RoutingProfile } from "./domain/task.js";
import { orchestrate, shouldOrchestrate } from "./orchestration/orchestrator.js";
import { refreshDealsFromOfficial, refreshPricingFromOfficial } from "./pricing/refresh.js";
import {
  loadDealSnapshot,
  loadPricingSnapshot,
  savePricingSnapshot,
  snapshotAgeMs,
} from "./pricing/snapshot.js";
import { formatExplain } from "./router/explain.js";
import { RouteError, selectRoute } from "./router/select.js";
import { warnUnsafeYolo } from "./security/command-policy.js";
import { RecursionError, assertCcrouteEntryAllowed } from "./security/recursion-guard.js";
import { spawnCommandCode } from "./subprocess/commandcode.js";
import { aggregateByModel, formatStats } from "./telemetry/aggregate.js";
import { appendTelemetry, readTelemetryEvents } from "./telemetry/store.js";

const program = new Command();
program
  .name("ccroute")
  .description("Deterministic deal-aware CommandCode model router and role orchestrator")
  .version("0.1.0");

function fail(err: unknown, code = 1): never {
  const msg = err instanceof Error ? err.message : String(err);
  const c =
    err instanceof RouteError || err instanceof ConfigError || err instanceof RecursionError
      ? (err as { code?: string }).code
      : undefined;
  console.error(c ? `[${c}] ${msg}` : msg);
  process.exit(code);
}

function loadRuntime(cli?: Record<string, unknown>) {
  const overrides = cli && Object.keys(cli).length > 0 ? { cliOverrides: cli } : undefined;
  return loadConfig(overrides);
}

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

      const report = {
        nodeVersion: process.version,
        cmdPath: caps.cmd.path,
        commandCodeVersion: caps.cmd.version,
        authenticated: caps.status?.authenticated ?? null,
        user: caps.status?.user ?? null,
        availableModelCount: caps.modelIds.length,
        availableModelIds: caps.modelIds,
        configFiles: loaded.sources,
        pricingSnapshotAgeMs: snapshotAgeMs(pricing.retrievedAt, now),
        dealSnapshotAgeMs: snapshotAgeMs(deals.retrievedAt, now),
        expiredDeals,
        writePermissionPolicy: "writes require explicit --apply; --auto-accept only then",
        telemetryPath: loaded.config.telemetry.path,
        recursiveInvocation: process.env.CCROUTE_CHILD === "1",
        unsupportedAssumptions: caps.contradictions,
        supportedFlags: caps.supportedFlags,
      };

      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log("ccroute doctor");
        console.log(`  Node: ${report.nodeVersion}`);
        console.log(`  cmd: ${report.cmdPath ?? "(missing)"}`);
        console.log(`  CommandCode: ${report.commandCodeVersion ?? "(unknown)"}`);
        console.log(`  Auth: ${report.authenticated}`);
        console.log(`  Models: ${report.availableModelCount}`);
        console.log(`  Config: ${report.configFiles.join(" | ")}`);
        console.log(`  Pricing age: ${Math.round(report.pricingSnapshotAgeMs / 1000)}s`);
        console.log(`  Expired deals: ${expiredDeals.join(", ") || "(none)"}`);
        console.log(`  Telemetry: ${report.telemetryPath}`);
        console.log(`  Write policy: ${report.writePermissionPolicy}`);
        if (report.unsupportedAssumptions.length) {
          console.log(`  Contradictions: ${report.unsupportedAssumptions.join("; ")}`);
        }
      }
      process.exit(caps.cmd.path ? 0 : 2);
    } catch (e) {
      fail(e);
    }
  });

const models = program.command("models").description("Model catalog");
models.command("list").action(() => {
  try {
    const loaded = loadRuntime();
    const cmd = resolveCmdPath(loaded.config.cmdPath);
    if (!cmd) fail(new Error("cmd not found"));
    const live = fetchLiveModelIds(cmd!);
    if (live.error) fail(new Error(live.error));
    for (const id of live.ids) console.log(id);
  } catch (e) {
    fail(e);
  }
});
models.command("refresh").action(() => {
  try {
    const loaded = loadRuntime();
    const cmd = resolveCmdPath(loaded.config.cmdPath);
    if (!cmd) fail(new Error("cmd not found"));
    const live = fetchLiveModelIds(cmd!);
    if (live.error) fail(new Error(live.error));
    const snap = loadPricingSnapshot();
    const liveSet = new Set(live.ids);
    // Keep pricing for known models; do not invent IDs
    const next = {
      ...snap,
      retrievedAt: new Date().toISOString(),
      source: "cmd --list-models + prior snapshot",
      sourceHash: `models-${live.ids.length}-${Date.now()}`,
      models: snap.models.map((m) =>
        liveSet.has(m.id) || m.availability === "expired_deal"
          ? m
          : { ...m, availability: "unavailable" as const },
      ),
    };
    savePricingSnapshot(next);
    console.log(`Refreshed model identities from live catalog (${live.ids.length} ids).`);
  } catch (e) {
    fail(e);
  }
});

const dealsCmd = program.command("deals").description("Deal snapshots");
dealsCmd.command("list").action(() => {
  const d = loadDealSnapshot();
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
  const now = Date.now();
  for (const deal of d.deals) {
    const exp = deal.expiresAt ? Date.parse(deal.expiresAt) <= now : false;
    console.log(`  ${deal.modelId}: ${exp ? "EXPIRED" : "active"} (${deal.label})`);
  }
});
dealsCmd
  .command("refresh")
  .option("--network", "Attempt official page fetch")
  .action(async (opts) => {
    const r = await refreshDealsFromOfficial({
      allowNetwork: Boolean(opts.network),
      fetchImpl: globalThis.fetch,
    });
    const p = await refreshPricingFromOfficial({
      allowNetwork: Boolean(opts.network),
      fetchImpl: globalThis.fetch,
    });
    if (!r.ok) console.error(r.error);
    if (!p.ok) console.error(p.error);
    if (r.ok) console.log("Deals snapshot refreshed.");
    if (p.ok) console.log("Pricing snapshot refreshed.");
    process.exit(r.ok && p.ok ? 0 : 1);
  });

/** Commander treats bare `--no-*` specially; accept both flags via argv. */
function wantsNoFree(opts: { excludeFree?: boolean; noFree?: boolean }): boolean {
  return Boolean(
    opts.excludeFree ||
      opts.noFree ||
      process.argv.includes("--no-free") ||
      process.argv.includes("--exclude-free"),
  );
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
) {
  assertCcrouteEntryAllowed();
  const noFree = wantsNoFree(opts);
  const loaded = loadRuntime({
    ...(noFree ? { noFree: true } : {}),
  });
  const task = classifyTask(taskText);
  const pricing = loadPricingSnapshot();
  const cmd = resolveCmdPath(loaded.config.cmdPath);
  let liveIds: Set<string> | null = null;
  if (cmd) {
    const live = fetchLiveModelIds(cmd);
    if (live.ids.length) liveIds = new Set(live.ids);
  }
  // For decide, live catalog is preferred but seed-only offline mode allowed if cmd missing
  const events = loaded.config.telemetry.enabled
    ? readTelemetryEvents(loaded.config.telemetry.path)
    : [];
  const telemetry = aggregateByModel(events);
  const decision = selectRoute({
    models: pricing.models,
    liveModelIds: liveIds,
    config: loaded.config,
    task,
    profile: opts.profile as RoutingProfile | undefined,
    telemetry,
    pricingRetrievedAt: pricing.retrievedAt,
    maxEstimatedCost: opts.maxEstimatedCost ? Number(opts.maxEstimatedCost) : undefined,
    noFree,
    cliModel: opts.model,
  });
  return { task, decision, loaded, pricing, cmd };
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
      fail(e, 2);
    }
  });

program
  .command("explain")
  .argument("<task...>", "Task text")
  .option("--profile <profile>", "cheapest|balanced|frontier")
  .option("--model <id>", "Explicit model override")
  .option("--exclude-free", "Exclude free models")
  .option("--no-free", "Exclude free models (alias of --exclude-free)")
  .option("--max-estimated-cost <usd>", "Max expected cost")
  .action((taskParts: string[], opts) => {
    try {
      const { task, decision } = decideCore(taskParts.join(" "), opts);
      console.log(formatExplain(task, decision));
    } catch (e) {
      fail(e, 2);
    }
  });

async function ensureGitSafety(apply: boolean, allowDirty: boolean, orchestrating: boolean) {
  if (!apply || !orchestrating) return;
  const { spawnSync } = await import("node:child_process");
  const st = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", shell: false });
  if (st.status !== 0) return; // not a git repo
  if (st.stdout.trim() && !allowDirty) {
    throw new RouteError(
      "DIRTY_WORKTREE",
      "Dirty worktree blocked for orchestration --apply (use --allow-dirty to override)",
    );
  }
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
  .option("--allow-dirty", "Allow dirty worktree")
  .action(async (taskParts: string[], opts) => {
    try {
      assertCcrouteEntryAllowed();
      if (opts.unsafeYolo) console.error(warnUnsafeYolo());
      const { task, decision, loaded, cmd } = decideCore(taskParts.join(" "), opts);
      if (!cmd) fail(new Error("cmd not found"));
      await ensureGitSafety(Boolean(opts.apply), Boolean(opts.allowDirty), false);

      const runId = randomUUID();
      const runDir = join(process.cwd(), ".commandcode", "deal-router", "runs", runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "decision.json"), JSON.stringify(decision, null, 2));
      writeFileSync(join(runDir, "task.json"), JSON.stringify(task, null, 2));

      console.error(
        `Route: ${decision.selectedModelId} (${decision.taskClass}/${decision.profile})`,
      );
      if (!opts.apply) console.error("Read-only run (no --apply).");

      const tel = opts.telemetry !== false && loaded.config.telemetry.enabled;
      if (tel) {
        appendTelemetry(loaded.config.telemetry.path, {
          schemaVersion: 1,
          ts: new Date().toISOString(),
          runId,
          event: decision.overridesApplied.length ? "override" : "run_start",
          modelId: decision.selectedModelId,
          taskClass: task.taskClass,
        });
      }

      const res = await spawnCommandCode({
        cmdPath: cmd!,
        model: decision.selectedModelId,
        stdinText: task.cleanedText,
        plan: false,
        autoAccept: Boolean(opts.apply),
        unsafeYolo: Boolean(opts.unsafeYolo) && Boolean(opts.apply),
        maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined,
        trust: Boolean(opts.trustProject),
        timeoutMs: loaded.config.security.defaultTimeoutMs,
        maxStdoutBytes: loaded.config.security.maxResultBytes,
        cwd: process.cwd(),
        role: "executor",
        runId,
      });

      writeFileSync(join(runDir, "executor-raw.txt"), res.stdout, "utf8");
      writeFileSync(
        join(runDir, "manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            runId,
            mode: "single",
            model: decision.selectedModelId,
            apply: Boolean(opts.apply),
            exitCode: res.exitCode,
            timedOut: res.timedOut,
            argv: res.argv,
          },
          null,
          2,
        ),
      );

      if (tel) {
        appendTelemetry(loaded.config.telemetry.path, {
          schemaVersion: 1,
          ts: new Date().toISOString(),
          runId,
          event: res.timedOut ? "timeout" : "run_end",
          modelId: decision.selectedModelId,
          taskClass: task.taskClass,
          success: res.exitCode === 0 && !res.timedOut,
          latencyMs: res.durationMs,
          estimatedCostUsd: decision.candidates[0]?.cost.expectedTotalCost,
        });
      }

      process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      process.exit(res.exitCode ?? 1);
    } catch (e) {
      fail(e, 2);
    }
  });

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
  .option("--allow-dirty", "Allow dirty worktree with --apply")
  .option("--trust-project", "Pass --trust")
  .option("--unsafe-yolo", "Dangerous yolo")
  .option("--no-telemetry", "Disable telemetry")
  .option("--force", "Orchestrate even for trivial tasks")
  .action(async (taskParts: string[], opts) => {
    try {
      assertCcrouteEntryAllowed();
      if (opts.unsafeYolo) console.error(warnUnsafeYolo());
      const { task, decision, loaded, cmd } = decideCore(taskParts.join(" "), opts);
      if (!cmd) fail(new Error("cmd not found"));
      if (!opts.force && !shouldOrchestrate(task, loaded.config)) {
        console.error(
          `Task class ${task.taskClass} does not justify multi-role orchestration; use ccroute run (or --force).`,
        );
        process.exit(3);
      }
      await ensureGitSafety(Boolean(opts.apply), Boolean(opts.allowDirty), true);

      const runId = randomUUID();
      const runDir = join(process.cwd(), ".commandcode", "deal-router", "runs", runId);
      console.error(
        `Orchestrate route default=${decision.selectedModelId} class=${task.taskClass}`,
      );

      const result = await orchestrate({
        cmdPath: cmd!,
        config: loaded.config,
        task,
        decision,
        apply: Boolean(opts.apply),
        unsafeYolo: Boolean(opts.unsafeYolo),
        trust: Boolean(opts.trustProject),
        cwd: process.cwd(),
        runDir,
        telemetryPath: loaded.config.telemetry.path,
        telemetryEnabled: opts.telemetry !== false && loaded.config.telemetry.enabled,
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
        },
      });

      console.log(
        JSON.stringify(
          { runId: result.runId, summary: result.summary, roles: Object.keys(result.roles) },
          null,
          2,
        ),
      );
      console.error(`Artifacts: ${runDir}`);
      process.exit(result.exitCode);
    } catch (e) {
      fail(e, 2);
    }
  });

program
  .command("stats")
  .option("--model <id>", "Filter model")
  .option("--task-class <class>", "Filter task class")
  .action((opts) => {
    try {
      const loaded = loadRuntime();
      const events = readTelemetryEvents(loaded.config.telemetry.path);
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

const configCmd = program.command("config").description("Configuration");
configCmd.command("show").action(() => {
  const loaded = loadRuntime();
  console.log(JSON.stringify(loaded.config, null, 2));
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

program.parseAsync(process.argv).catch((e) => fail(e));
