import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoutingConfig } from "../config/schemas.js";
import type { RouteDecision } from "../domain/route.js";
import type { ClassifiedTask } from "../domain/task.js";
import { spawnCommandCode } from "../subprocess/commandcode.js";
import { appendTelemetry } from "../telemetry/store.js";
import { buildRoleStdin } from "./packet.js";
import { type RoleResult, formatRepairPrompt, parseRoleResult } from "./result-parser.js";
import { type RoleName, roleNeedsPlanMode, roleNeedsWrite } from "./roles.js";
import { sanitizeRoleResult, validateRoleSemantics } from "./validation.js";

export interface OrchestrateOptions {
  cmdPath: string;
  config: RoutingConfig;
  task: ClassifiedTask;
  decision: RouteDecision;
  apply: boolean;
  unsafeYolo?: boolean;
  trust?: boolean;
  cwd?: string;
  runDir: string;
  telemetryPath?: string;
  telemetryEnabled?: boolean;
  models: {
    planner?: string;
    advisor?: string;
    executor?: string;
    reviewer?: string;
  };
  flags: {
    noPlanner?: boolean;
    noAdvisor?: boolean;
    noReviewer?: boolean;
    maxTurns?: number;
  };
  spawnImpl?: typeof spawnCommandCode;
}

export interface OrchestrateResult {
  runId: string;
  roles: Partial<Record<RoleName, RoleResult>>;
  exitCode: number;
  summary: string;
  blockedReason?: string;
}

async function runRole(
  opts: OrchestrateOptions,
  role: RoleName,
  model: string,
  stdin: string,
  runId: string,
): Promise<{ result?: RoleResult; raw: string; error?: string; exitCode: number }> {
  const spawn = opts.spawnImpl ?? spawnCommandCode;
  const maxTurns =
    opts.flags.maxTurns ??
    (role === "planner"
      ? opts.config.orchestration.plannerMaxTurns
      : role === "advisor"
        ? opts.config.orchestration.advisorMaxTurns
        : role === "reviewer"
          ? opts.config.orchestration.reviewerMaxTurns
          : opts.config.orchestration.executorMaxTurns);

  const autoAccept = roleNeedsWrite(role, opts.apply);
  const plan = roleNeedsPlanMode(role);

  let currentStdin = stdin;
  let lastRaw = "";
  let lastError = "";

  for (let attempt = 0; attempt <= opts.config.orchestration.maxFormatRepairs; attempt++) {
    if (opts.telemetryEnabled && opts.telemetryPath) {
      appendTelemetry(opts.telemetryPath, {
        schemaVersion: 1,
        ts: new Date().toISOString(),
        runId,
        event: attempt === 0 ? "role_start" : "repair",
        modelId: model,
        taskClass: opts.task.taskClass,
      });
    }

    const res = await spawn({
      cmdPath: opts.cmdPath,
      model,
      stdinText: currentStdin,
      plan,
      autoAccept,
      unsafeYolo: opts.unsafeYolo && autoAccept,
      maxTurns,
      trust: opts.trust,
      timeoutMs: opts.config.security.defaultTimeoutMs,
      maxStdoutBytes: opts.config.security.maxResultBytes,
      cwd: opts.cwd,
      role,
      runId,
    });

    lastRaw = res.stdout;
    writeFileSync(join(opts.runDir, `${role}-raw-${attempt}.txt`), res.stdout, "utf8");

    if (res.timedOut) {
      return { raw: lastRaw, error: "timeout", exitCode: res.exitCode ?? 1 };
    }
    if (res.exitCode && res.exitCode !== 0) {
      // still try parse
    }

    const parsed = parseRoleResult(res.stdout);
    if (!parsed.ok) {
      lastError = parsed.error;
      currentStdin = `${stdin}\n\n${formatRepairPrompt(parsed.error)}`;
      continue;
    }
    const sem = validateRoleSemantics(role, parsed.result);
    if (!sem.ok) {
      lastError = sem.error;
      currentStdin = `${stdin}\n\n${formatRepairPrompt(sem.error)}`;
      continue;
    }
    const clean = sanitizeRoleResult(parsed.result);
    writeFileSync(join(opts.runDir, `${role}-result.json`), JSON.stringify(clean, null, 2));
    if (opts.telemetryEnabled && opts.telemetryPath) {
      appendTelemetry(opts.telemetryPath, {
        schemaVersion: 1,
        ts: new Date().toISOString(),
        runId,
        event: "role_end",
        modelId: model,
        taskClass: opts.task.taskClass,
        success: clean.status === "success",
        latencyMs: res.durationMs,
      });
    }
    return { result: clean, raw: lastRaw, exitCode: res.exitCode ?? 0 };
  }

  return {
    raw: lastRaw,
    error: `role result validation failed twice: ${lastError}`,
    exitCode: 2,
  };
}

export async function orchestrate(opts: OrchestrateOptions): Promise<OrchestrateResult> {
  const runId = randomUUID();
  mkdirSync(opts.runDir, { recursive: true });
  writeFileSync(join(opts.runDir, "task.json"), JSON.stringify(opts.task, null, 2));
  writeFileSync(join(opts.runDir, "decision.json"), JSON.stringify(opts.decision, null, 2));

  const roles: Partial<Record<RoleName, RoleResult>> = {};
  const defaultModel = opts.decision.selectedModelId;
  const plannerModel = opts.models.planner ?? defaultModel;
  const advisorModel = opts.models.advisor ?? pickDifferent(defaultModel, plannerModel, opts);
  const executorModel = opts.models.executor ?? defaultModel;
  const reviewerModel = opts.models.reviewer ?? defaultModel;

  let plan: unknown = null;

  if (!opts.flags.noPlanner) {
    const stdin = buildRoleStdin({
      role: "planner",
      task: opts.task.cleanedText,
      riskSignals: opts.task.signals,
      acceptance: ["Produce a bounded plan", "Do not modify files"],
    });
    const r = await runRole(opts, "planner", plannerModel, stdin, runId);
    if (r.error || !r.result) {
      return {
        runId,
        roles,
        exitCode: r.exitCode || 2,
        summary: r.error ?? "planner failed",
        blockedReason: r.error,
      };
    }
    roles.planner = r.result;
    plan = r.result.artifacts[0] ?? r.result.summary;

    if (!opts.flags.noAdvisor) {
      let revisions = 0;
      while (revisions <= opts.config.orchestration.maxPlannerRevisions) {
        const astdin = buildRoleStdin({
          role: "advisor",
          task: opts.task.cleanedText,
          plan,
          riskSignals: opts.task.signals,
        });
        // Enforce independence: advisor model must differ when both enabled
        const advModel =
          advisorModel === plannerModel
            ? pickDifferent(plannerModel, plannerModel, opts)
            : advisorModel;
        const ar = await runRole(opts, "advisor", advModel, astdin, runId);
        if (ar.error || !ar.result) {
          return {
            runId,
            roles,
            exitCode: ar.exitCode || 2,
            summary: ar.error ?? "advisor failed",
            blockedReason: ar.error,
          };
        }
        roles.advisor = ar.result;
        if (ar.result.decision === "PLAN_APPROVED" || !ar.result.decision) break;
        if (ar.result.decision === "PLAN_REQUIRES_REVISION") {
          revisions += 1;
          if (revisions > opts.config.orchestration.maxPlannerRevisions) {
            return {
              runId,
              roles,
              exitCode: 3,
              summary: "Planner revision limit reached",
              blockedReason: "PLAN_REQUIRES_REVISION limit",
            };
          }
          const pstdin = buildRoleStdin({
            role: "planner",
            task: opts.task.cleanedText,
            previous: ar.result,
            riskSignals: opts.task.signals,
          });
          const pr = await runRole(opts, "planner", plannerModel, pstdin, runId);
          if (pr.error || !pr.result) {
            return {
              runId,
              roles,
              exitCode: pr.exitCode || 2,
              summary: pr.error ?? "planner revision failed",
              blockedReason: pr.error,
            };
          }
          roles.planner = pr.result;
          plan = pr.result.artifacts[0] ?? pr.result.summary;
        } else break;
      }
    }
  }

  const estdin = buildRoleStdin({
    role: "executor",
    task: opts.task.cleanedText,
    plan,
    constraints: opts.apply
      ? ["Writes authorized via --apply"]
      : ["Do not write files; propose changes only"],
  });
  const er = await runRole(opts, "executor", executorModel, estdin, runId);
  if (er.error || !er.result) {
    return {
      runId,
      roles,
      exitCode: er.exitCode || 2,
      summary: er.error ?? "executor failed",
      blockedReason: er.error,
    };
  }
  roles.executor = er.result;

  if (!opts.flags.noReviewer) {
    const rstdin = buildRoleStdin({
      role: "reviewer",
      task: opts.task.cleanedText,
      plan,
      previous: er.result,
    });
    const rr = await runRole(opts, "reviewer", reviewerModel, rstdin, runId);
    if (rr.error || !rr.result) {
      return {
        runId,
        roles,
        exitCode: rr.exitCode || 2,
        summary: rr.error ?? "reviewer failed",
        blockedReason: rr.error,
      };
    }
    roles.reviewer = rr.result;

    if (rr.result.decision === "REPAIR_REQUIRED") {
      const fixStdin = buildRoleStdin({
        role: "repair",
        task: opts.task.cleanedText,
        plan,
        previous: rr.result,
      });
      const fr = await runRole(opts, "repair", executorModel, fixStdin, runId);
      if (fr.result) roles.repair = fr.result;
      if (fr.error) {
        return {
          runId,
          roles,
          exitCode: 4,
          summary: "Repair failed after review",
          blockedReason: fr.error,
        };
      }
    } else if (rr.result.decision === "BLOCKED") {
      writeManifest(opts, runId, roles, "BLOCKED");
      return {
        runId,
        roles,
        exitCode: 5,
        summary: "Reviewer blocked",
        blockedReason: rr.result.summary,
      };
    }
  }

  writeManifest(opts, runId, roles, "OK");
  return {
    runId,
    roles,
    exitCode: 0,
    summary: "Orchestration complete",
  };
}

function pickDifferent(a: string, b: string, opts: OrchestrateOptions): string {
  // Prefer a capable alternate from candidates
  const alts = opts.decision.candidates.map((c) => c.modelId).filter((id) => id !== a && id !== b);
  return alts[0] ?? a;
}

function writeManifest(
  opts: OrchestrateOptions,
  runId: string,
  roles: Partial<Record<RoleName, RoleResult>>,
  status: string,
): void {
  const manifest = {
    schemaVersion: 1,
    runId,
    status,
    apply: opts.apply,
    taskClass: opts.task.taskClass,
    selectedModel: opts.decision.selectedModelId,
    roles: Object.keys(roles),
    ts: new Date().toISOString(),
  };
  writeFileSync(join(opts.runDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(opts.runDir, "summary.md"),
    `# Run ${runId}\n\nStatus: ${status}\nApply: ${opts.apply}\nRoles: ${Object.keys(roles).join(", ")}\n`,
  );
}

export function shouldOrchestrate(task: ClassifiedTask, config: RoutingConfig): boolean {
  const order = [
    "read_only",
    "trivial_edit",
    "standard_build",
    "complex_build",
    "architecture",
    "high_risk_review",
  ] as const;
  const min = config.orchestration.minClassForOrchestration;
  return order.indexOf(task.taskClass) >= order.indexOf(min);
}
