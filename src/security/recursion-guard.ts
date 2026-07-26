/**
 * Primary recursion boundary for the ccroute executable.
 *
 * Environment contract (TP-CCROUTE-AUTO-001 / ADR-CCROUTE-001):
 *
 *   CCROUTE_CHILD  — "1" when process is a bounded child role
 *   CCROUTE_DEPTH  — nesting depth; missing/empty treated as 0
 *   CCROUTE_ROLE   — role name for child sessions (informational)
 *   CCROUTE_RUN_ID — run id for child sessions (informational)
 *
 * Rules:
 *   depth missing → 0
 *   depth = 0 → ordinary invocation allowed
 *   depth = 1 and CCROUTE_CHILD = 1 → reject external ccroute
 *   depth > 1 → reject unconditionally
 *
 * Malformed depth fails closed (treated as already nested).
 *
 * There is intentionally NO public environment toggle that grants nested
 * orchestration to an accidental child shell. Internal in-process helpers
 * (selectRoute, classifyTask, etc.) do not consult these env vars and are
 * not reachable as a second CLI entry without going through this guard.
 */

export const ENV_CHILD = "CCROUTE_CHILD";
export const ENV_DEPTH = "CCROUTE_DEPTH";
export const ENV_ROLE = "CCROUTE_ROLE";
export const ENV_RUN_ID = "CCROUTE_RUN_ID";

export class RecursionError extends Error {
  readonly code = "RECURSION_BLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "RecursionError";
  }
}

// Sentinel returned by readDepth() when CCROUTE_DEPTH is present but unparsable.
// Deliberately larger than every depth threshold so malformed values always block.
const MALFORMED_DEPTH_SENTINEL = Number.POSITIVE_INFINITY;

/**
 * Security-relevant design choice: a *malformed* CCROUTE_DEPTH (present but not a
 * finite integer, e.g. "nope") is treated as fail-closed — "already nested / already
 * blocked" — rather than fail-open as depth 0 ("fresh top-level entry").
 */
export function readDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_DEPTH];
  if (raw === undefined || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : MALFORMED_DEPTH_SENTINEL;
}

export function isChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_CHILD] === "1";
}

/**
 * Lightweight check used by orchestration internals before spawning nested work.
 * Blocks only when depth already exceeds 1.
 */
export function assertNotRecursive(env: NodeJS.ProcessEnv = process.env): void {
  const depth = readDepth(env);
  if (depth > 1) {
    throw new RecursionError(
      `Recursive ccroute invocation blocked (CCROUTE_DEPTH=${depth}). Child role processes must not launch orchestration.`,
    );
  }
}

/**
 * Primary entry guard for every external `ccroute` CLI invocation.
 * Call at the executable entry layer before any command action runs.
 */
export function assertCcrouteEntryAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const depth = readDepth(env);

  // depth > 1 (including malformed → Infinity): reject unconditionally
  if (depth > 1) {
    throw new RecursionError(
      `CCROUTE_DEPTH=${Number.isFinite(depth) ? depth : env[ENV_DEPTH]} rejected (max allowed entry depth is 1)`,
    );
  }

  // depth = 1 and child, OR child at any depth ≤ 1: reject external re-entry
  if (isChildProcess(env)) {
    throw new RecursionError(
      "ccroute refused: process is a bounded child role (CCROUTE_CHILD=1). Do not nest orchestration.",
    );
  }
}

/** Alias documenting the primary (binary-level) recursion boundary. */
export const assertPrimaryRecursionGuard = assertCcrouteEntryAllowed;

export function childEnv(role: string, runId: string, parentDepth = 0): Record<string, string> {
  return {
    [ENV_CHILD]: "1",
    [ENV_DEPTH]: String(parentDepth + 1),
    [ENV_ROLE]: role,
    [ENV_RUN_ID]: runId,
  };
}

export const CHILD_ROLE_INSTRUCTION =
  "You are a bounded role process. Do not invoke ccroute or launch another CommandCode orchestration run.";
