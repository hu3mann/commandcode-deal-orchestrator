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

export function readDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_DEPTH];
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
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
