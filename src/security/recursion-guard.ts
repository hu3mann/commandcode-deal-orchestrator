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
// Deliberately chosen to be larger than every depth threshold checked below
// (assertNotRecursive's `> 1` and assertCcrouteEntryAllowed's `>= 2`), so a
// malformed value is always treated as "blocked", never as "fresh entry".
const MALFORMED_DEPTH_SENTINEL = Number.POSITIVE_INFINITY;

/**
 * Security-relevant design choice: a *malformed* CCROUTE_DEPTH (present but not a
 * finite integer, e.g. "nope") is treated as fail-closed — "already nested / already
 * blocked" — rather than fail-open as depth 0 ("fresh top-level entry").
 *
 * Rationale: the recursion guard's job is to stop a child role process from
 * re-invoking ccroute. If a corrupted or adversarially-set CCROUTE_DEPTH value could
 * reset the guard's view of depth back to 0, that would be a bypass primitive — worse
 * than useless, since it would look *more* trustworthy (fresh entry) than an honestly
 * missing value. A genuinely absent CCROUTE_DEPTH (the normal, non-nested case) still
 * returns 0; only a present-but-garbage value fails closed.
 *
 * This does not (and cannot, from inside this process) defend against a child that
 * strips CCROUTE_DEPTH/CCROUTE_CHILD entirely before re-exec'ing — see the hooks'
 * residual-risk notes.
 */
export function readDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_DEPTH];
  if (raw === undefined || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : MALFORMED_DEPTH_SENTINEL;
}

export function assertNotRecursive(env: NodeJS.ProcessEnv = process.env): void {
  const depth = readDepth(env);
  if (depth > 1) {
    throw new RecursionError(
      `Recursive ccroute invocation blocked (CCROUTE_DEPTH=${depth}). Child role processes must not launch orchestration.`,
    );
  }
}

/** Call at start of ccroute CLI when about to orchestrate/run */
export function assertCcrouteEntryAllowed(env: NodeJS.ProcessEnv = process.env): void {
  const depth = readDepth(env);
  if (depth >= 2) {
    throw new RecursionError(`CCROUTE_DEPTH=${depth} rejected (max allowed entry depth is 1)`);
  }
  // If already a child role process, refuse to run ccroute commands that launch more work
  if (env[ENV_CHILD] === "1") {
    throw new RecursionError(
      "ccroute refused: process is a bounded child role (CCROUTE_CHILD=1). Do not nest orchestration.",
    );
  }
}

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
