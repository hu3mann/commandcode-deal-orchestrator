import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RouteDecision } from "../domain/route.js";
import type { ClassifiedTask } from "../domain/task.js";
import { pricingSnapshotPath } from "../pricing/snapshot.js";
import { redactText } from "../telemetry/redact.js";
import type { RoleResult } from "./result-parser.js";
import type { RoleName } from "./roles.js";
import type { ValidationGateResult } from "./validation-gate.js";

/**
 * §31 run-artifact naming and §24/§5 write discipline: every artifact is written
 * tmp-then-rename (mirrors src/pricing/snapshot.ts's writeFileFsynced+renameSync pattern)
 * and redacted before it ever touches disk (redactText is owned by the telemetry unit —
 * called here, not reimplemented).
 */

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/** Atomic write: write+fsync a `${path}.tmp.<pid>.<ts>` file, then renameSync over the
 * destination. A crash or concurrent read mid-write can never observe a partial file. */
export function writeArtifactAtomic(path: string, content: string): void {
  ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Redact before persisting (defect: raw child stdout was written unredacted). */
export function writeRedactedTextAtomic(path: string, content: string): void {
  writeArtifactAtomic(path, redactText(content));
}

export function roleResultFilename(role: RoleName): string {
  // §31: the reviewer's result artifact is named review-result.json, not
  // reviewer-result.json (the generic `${role}-result.json` pattern used elsewhere).
  return role === "reviewer" ? "review-result.json" : `${role}-result.json`;
}

export function writeRoleResultAtomic(runDir: string, role: RoleName, result: RoleResult): void {
  writeArtifactAtomic(join(runDir, roleResultFilename(role)), JSON.stringify(result, null, 2));
}

export function writeRoleRawAtomic(
  runDir: string,
  role: RoleName,
  attempt: number,
  rawStdout: string,
): void {
  writeRedactedTextAtomic(join(runDir, `${role}-raw-${attempt}.txt`), rawStdout);
}

export function writeTaskMetadataAtomic(runDir: string, task: ClassifiedTask): void {
  // §31: task-metadata.json, not task.json.
  writeArtifactAtomic(join(runDir, "task-metadata.json"), JSON.stringify(task, null, 2));
}

export function writeDecisionAtomic(runDir: string, decision: RouteDecision): void {
  writeArtifactAtomic(join(runDir, "decision.json"), JSON.stringify(decision, null, 2));
}

export function writeTestsArtifactAtomic(runDir: string, gate: ValidationGateResult): void {
  // §31: tests.json — the deterministic validation gate's structured result, redacted
  // (command output may echo environment/config content).
  writeRedactedTextAtomic(join(runDir, "tests.json"), JSON.stringify(gate, null, 2));
}

/** Best-effort copy of the resolved pricing snapshot into the run dir for audit purposes.
 * Never throws — a missing/unreadable snapshot must not fail an orchestration run. */
export function copyPricingSnapshotBestEffort(runDir: string): void {
  try {
    const src = pricingSnapshotPath();
    if (!existsSync(src)) return;
    const content = readFileSync(src, "utf8");
    writeArtifactAtomic(join(runDir, "pricing-snapshot.json"), content);
  } catch {
    /* best-effort only */
  }
}

export interface ManifestInput {
  runId: string;
  status: string;
  apply: boolean;
  task: ClassifiedTask;
  decision: RouteDecision;
  roles: Partial<Record<RoleName, RoleResult>>;
  blockedReason?: string;
}

/** Writes manifest.json + summary.md. Must be called on EVERY terminal path of
 * orchestrate() (defect: previously only 2 of ~9 return points wrote a manifest). */
export function writeManifestAtomic(runDir: string, input: ManifestInput): void {
  const manifest = {
    schemaVersion: 1,
    runId: input.runId,
    status: input.status,
    apply: input.apply,
    taskClass: input.task.taskClass,
    selectedModel: input.decision.selectedModelId,
    roles: Object.keys(input.roles),
    blockedReason: input.blockedReason ?? null,
    ts: new Date().toISOString(),
  };
  writeArtifactAtomic(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const lines = [
    `# Run ${input.runId}`,
    "",
    `Status: ${input.status}`,
    `Apply: ${input.apply}`,
    `Roles: ${Object.keys(input.roles).join(", ") || "(none)"}`,
  ];
  if (input.blockedReason) lines.push(`Blocked reason: ${redactText(input.blockedReason)}`);
  writeArtifactAtomic(join(runDir, "summary.md"), `${lines.join("\n")}\n`);
}
