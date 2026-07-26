import type { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { RoutingConfig } from "../config/schemas.js";
import type { RouteDecision } from "../domain/route.js";
import type { ClassifiedTask } from "../domain/task.js";
import { spawnCommandCode } from "../subprocess/commandcode.js";
import { appendTelemetry } from "../telemetry/store.js";
import {
  copyPricingSnapshotBestEffort,
  writeDecisionAtomic,
  writeManifestAtomic,
  writeRoleRawAtomic,
  writeRoleResultAtomic,
  writeTaskMetadataAtomic,
  writeTestsArtifactAtomic,
} from "./artifacts.js";
import { computeBoundedGitDiff } from "./diff.js";
import { RolePacketTooLargeError, buildRoleStdin } from "./packet.js";
import { type RoleResult, formatRepairPrompt, parseRoleResult } from "./result-parser.js";
import { type RoleName, roleNeedsPlanMode, roleNeedsWrite } from "./roles.js";
import {
  type ValidationGateConfig,
  type ValidationGateResult,
  formatValidationSummary,
  runValidationGate,
} from "./validation-gate.js";
import {
  type RoleSemanticsContext,
  sanitizeRoleResult,
  validateRoleSemantics,
} from "./validation.js";

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
    /**
     * §24.5: the deterministic validation gate defaults to ON. This is the ONLY
     * supported way to turn it off — an explicit, deliberate flag, never an implicit
     * side effect of some other option.
     */
    skipValidation?: boolean;
  };
  /** Injection seam for tests: never spawn a real CommandCode child from a unit test. */
  spawnImpl?: typeof spawnCommandCode;
  /**
   * §24.5 deterministic validation gate configuration. Sensible defaults apply when
   * omitted (see validation-gate.ts: type-check, lint, unit tests, build via npm
   * scripts). Once src/config/schemas.ts grows a `validation` block (see the wiring
   * note in the final report), cli.ts should populate this from
   * `loaded.config.validation`.
   */
  validationGate?: Partial<ValidationGateConfig>;
  /** Injection seam for tests: never spawn real validation commands (tsc/biome/vitest)
   * from inside a unit test — always supply a fake here. */
  validationSpawnImpl?: typeof spawn;
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
  semanticsContext?: RoleSemanticsContext,
): Promise<{ result?: RoleResult; raw: string; error?: string; exitCode: number }> {
  const spawnImpl = opts.spawnImpl ?? spawnCommandCode;
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

    const res = await spawnImpl({
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
    // Redact before persisting (defect §5: raw child stdout was written unredacted).
    writeRoleRawAtomic(opts.runDir, role, attempt, res.stdout);

    if (res.timedOut) {
      return { raw: lastRaw, error: "timeout", exitCode: res.exitCode ?? 1 };
    }

    const parsed = parseRoleResult(res.stdout);
    if (!parsed.ok) {
      lastError = parsed.error;
      currentStdin = `${stdin}\n\n${formatRepairPrompt(parsed.error)}`;
      continue;
    }
    const sem = validateRoleSemantics(role, parsed.result, semanticsContext);
    if (!sem.ok) {
      lastError = sem.error;
      currentStdin = `${stdin}\n\n${formatRepairPrompt(sem.error)}`;
      continue;
    }
    const clean = sanitizeRoleResult(parsed.result);
    writeRoleResultAtomic(opts.runDir, role, clean);
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
  writeTaskMetadataAtomic(opts.runDir, opts.task);
  writeDecisionAtomic(opts.runDir, opts.decision);

  const roles: Partial<Record<RoleName, RoleResult>> = {};
  const maxPromptBytes = opts.config.security.maxPromptBytes;

  /** Writes manifest.json + summary.md and returns the terminal result. Called on EVERY
   * return path (defect §5: previously only 2 of ~9 terminal paths wrote a manifest). */
  function finalize(
    status: string,
    exitCode: number,
    summary: string,
    blockedReason?: string,
  ): OrchestrateResult {
    writeManifestAtomic(opts.runDir, {
      runId,
      status,
      apply: opts.apply,
      task: opts.task,
      decision: opts.decision,
      roles,
      blockedReason,
    });
    copyPricingSnapshotBestEffort(opts.runDir);
    return { runId, roles, exitCode, summary, blockedReason };
  }

  function stdin(packet: Parameters<typeof buildRoleStdin>[0]): string {
    return buildRoleStdin(packet, { maxBytes: maxPromptBytes });
  }

  try {
    const defaultModel = opts.decision.selectedModelId;
    const plannerModel = opts.models.planner ?? defaultModel;
    const advisorModel =
      opts.models.advisor ?? pickDistinctModel(defaultModel, plannerModel, opts) ?? plannerModel;
    const executorModel = opts.models.executor ?? defaultModel;
    const reviewerModel = opts.models.reviewer ?? defaultModel;

    let plan: unknown = null;

    if (!opts.flags.noPlanner) {
      const pstdin = stdin({
        role: "planner",
        task: opts.task.cleanedText,
        riskSignals: opts.task.signals,
        acceptance: ["Produce a bounded plan", "Do not modify files"],
      });
      const r = await runRole(opts, "planner", plannerModel, pstdin, runId);
      if (r.error || !r.result) {
        return finalize("PLANNER_FAILED", r.exitCode || 2, r.error ?? "planner failed", r.error);
      }
      roles.planner = r.result;
      plan = r.result.artifacts[0] ?? r.result.summary;

      if (!opts.flags.noAdvisor) {
        // §24.3 fail-closed: identical planner/advisor model IDs must be REJECTED, never
        // silently substituted. This is layer 1; validateRoleSemantics carries layer 2.
        if (advisorModel === plannerModel) {
          return finalize(
            "ADVISOR_INDEPENDENCE_BLOCKED",
            7,
            "Advisor independence violated: planner and advisor would use the identical model",
            `planner and advisor both resolve to model "${plannerModel}"; §24.3 requires distinct models and forbids silently falling back to the same one when no distinct alternate is available`,
          );
        }

        let revisions = 0;
        while (revisions <= opts.config.orchestration.maxPlannerRevisions) {
          const astdin = stdin({
            role: "advisor",
            task: opts.task.cleanedText,
            plan,
            riskSignals: opts.task.signals,
          });
          const ar = await runRole(opts, "advisor", advisorModel, astdin, runId, {
            plannerModelId: plannerModel,
            advisorModelId: advisorModel,
          });
          if (ar.error || !ar.result) {
            return finalize(
              "ADVISOR_FAILED",
              ar.exitCode || 2,
              ar.error ?? "advisor failed",
              ar.error,
            );
          }
          roles.advisor = ar.result;
          if (ar.result.decision === "PLAN_APPROVED" || !ar.result.decision) break;
          if (ar.result.decision === "PLAN_REQUIRES_REVISION") {
            revisions += 1;
            if (revisions > opts.config.orchestration.maxPlannerRevisions) {
              return finalize(
                "PLANNER_REVISION_LIMIT",
                3,
                "Planner revision limit reached",
                "PLAN_REQUIRES_REVISION limit",
              );
            }
            const rpstdin = stdin({
              role: "planner",
              task: opts.task.cleanedText,
              previous: ar.result,
              riskSignals: opts.task.signals,
            });
            const pr = await runRole(opts, "planner", plannerModel, rpstdin, runId);
            if (pr.error || !pr.result) {
              return finalize(
                "PLANNER_REVISION_FAILED",
                pr.exitCode || 2,
                pr.error ?? "planner revision failed",
                pr.error,
              );
            }
            roles.planner = pr.result;
            plan = pr.result.artifacts[0] ?? pr.result.summary;
          } else break;
        }
      }
    }

    const estdin = stdin({
      role: "executor",
      task: opts.task.cleanedText,
      plan,
      constraints: opts.apply
        ? ["Writes authorized via --apply"]
        : ["Do not write files; propose changes only"],
    });
    const er = await runRole(opts, "executor", executorModel, estdin, runId);
    if (er.error || !er.result) {
      return finalize("EXECUTOR_FAILED", er.exitCode || 2, er.error ?? "executor failed", er.error);
    }
    roles.executor = er.result;
    let latestExecutorResult: RoleResult = er.result;

    // §24.5 deterministic validation gate: runs between Executor and Reviewer. Its
    // result is authoritative — the Reviewer's ACCEPT can never override a failing gate
    // (enforced by the unconditional check after the reviewer loop below).
    let gate: ValidationGateResult = await runValidationGate({
      config: opts.validationGate,
      skip: opts.flags.skipValidation,
      cwd: opts.cwd,
      spawnImpl: opts.validationSpawnImpl,
    });
    writeTestsArtifactAtomic(opts.runDir, gate);

    if (!opts.flags.noReviewer) {
      let repairCount = 0;
      while (true) {
        // §24.6: the Reviewer must receive the diff and the (real, populated) test
        // results — not review a diff/tests it was never given.
        const diff = computeBoundedGitDiff({
          cwd: opts.cwd,
          maxBytes: opts.config.security.maxResultBytes,
        });
        const rstdin = stdin({
          role: "reviewer",
          task: opts.task.cleanedText,
          plan,
          previous: latestExecutorResult,
          diffSummary: diff.diffSummary,
          testResults: formatValidationSummary(gate),
          fileBoundaries: diff.fileBoundaries,
        });
        const rr = await runRole(opts, "reviewer", reviewerModel, rstdin, runId);
        if (rr.error || !rr.result) {
          return finalize(
            "REVIEWER_FAILED",
            rr.exitCode || 2,
            rr.error ?? "reviewer failed",
            rr.error,
          );
        }
        roles.reviewer = rr.result;

        if (rr.result.decision === "REPAIR_REQUIRED") {
          // §3: maxRepairs is now a real loop bound, not an accident of code structure.
          if (repairCount >= opts.config.orchestration.maxRepairs) {
            return finalize(
              "REPAIR_LIMIT",
              4,
              "Repair limit reached",
              `maxRepairs=${opts.config.orchestration.maxRepairs} exhausted; reviewer still requires repair`,
            );
          }
          repairCount += 1;
          const fixStdin = stdin({
            role: "repair",
            task: opts.task.cleanedText,
            plan,
            previous: rr.result,
          });
          const fr = await runRole(opts, "repair", executorModel, fixStdin, runId);
          if (fr.error || !fr.result) {
            return finalize("REPAIR_FAILED", 4, "Repair failed after review", fr.error);
          }
          roles.repair = fr.result;
          latestExecutorResult = fr.result;
          // Re-run the deterministic gate: the repair may have changed the code, so the
          // previous gate result is stale and must not be reused.
          gate = await runValidationGate({
            config: opts.validationGate,
            skip: opts.flags.skipValidation,
            cwd: opts.cwd,
            spawnImpl: opts.validationSpawnImpl,
          });
          writeTestsArtifactAtomic(opts.runDir, gate);
          continue;
        }
        if (rr.result.decision === "BLOCKED") {
          return finalize("BLOCKED", 5, "Reviewer blocked", rr.result.summary);
        }
        break; // ACCEPT, or no decision supplied
      }
    }

    // Final gate: deterministic validation is authoritative regardless of the Reviewer's
    // decision. A Reviewer ACCEPT must never be able to override a failing test suite.
    if (gate.ran && !gate.passed) {
      return finalize(
        "VALIDATION_FAILED",
        6,
        "Deterministic validation failed; this cannot be overridden by a Reviewer ACCEPT",
        formatValidationSummary(gate),
      );
    }

    return finalize("OK", 0, "Orchestration complete");
  } catch (e) {
    if (e instanceof RolePacketTooLargeError) {
      return finalize("ROLE_PACKET_TOO_LARGE", 8, "Role packet exceeded maxPromptBytes", e.message);
    }
    throw e;
  }
}

/**
 * Picks a candidate model distinct from both `a` and `b` (typically the same value
 * twice: the default model and the resolved planner model). Returns `null` — never a
 * silent same-model fallback — when no distinct alternate exists (defect §2/AUD-008:
 * `alts[0] ?? a` used to fall back to the identical model with no error).
 */
function pickDistinctModel(a: string, b: string, opts: OrchestrateOptions): string | null {
  const alts = opts.decision.candidates.map((c) => c.modelId).filter((id) => id !== a && id !== b);
  return alts[0] ?? null;
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
