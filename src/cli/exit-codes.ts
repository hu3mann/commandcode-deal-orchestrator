/**
 * §11 exit-code taxonomy for ccroute.
 *
 *   0  success
 *   2  invalid CLI usage
 *  10  invalid configuration
 *  11  unavailable model
 *  12  invalid or stale pricing
 *  13  no eligible route
 *  14  estimated budget exceeded
 *  20  capability mismatch
 *  21  subprocess failure
 *  22  timeout
 *  23  invalid child output
 *  24  role protocol failure
 *  30  repository safety violation
 *  31  recursive invocation blocked
 *  32  unsafe permission request blocked
 *  40  live test unavailable
 *  50  internal invariant failure
 *
 * §11 explicitly forbids treating exit 1 as a generic catch-all: every error that reaches
 * the top-level CLI handler must resolve to one of the numbered codes above. An error whose
 * `.code` is not recognized by ERROR_CODE_EXIT_MAP is, by definition, a case this taxonomy
 * did not anticipate — that is an internal invariant failure (50), not a silent "1".
 */
export const EXIT = {
  SUCCESS: 0,
  INVALID_CLI_USAGE: 2,
  CONFIG_INVALID: 10,
  MODEL_UNAVAILABLE: 11,
  PRICING_INVALID_OR_STALE: 12,
  NO_ELIGIBLE_ROUTE: 13,
  BUDGET_EXCEEDED: 14,
  CAPABILITY_MISMATCH: 20,
  SUBPROCESS_FAILURE: 21,
  TIMEOUT: 22,
  INVALID_CHILD_OUTPUT: 23,
  ROLE_PROTOCOL_FAILURE: 24,
  REPOSITORY_SAFETY_VIOLATION: 30,
  RECURSIVE_INVOCATION_BLOCKED: 31,
  UNSAFE_PERMISSION_BLOCKED: 32,
  LIVE_TEST_UNAVAILABLE: 40,
  INTERNAL_INVARIANT_FAILURE: 50,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Thrown by cli.ts itself (not by any owned-elsewhere module) for CLI-usage-level problems
 * that Commander's own parser cannot catch — e.g. §22 conflicting task markers
 * (`!cheap !frontier`), or `--commit` supplied without `--apply`. Always maps to exit 2.
 */
export class CliUsageError extends Error {
  readonly code = "CLI_USAGE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/**
 * Maps a typed error's string `.code` (RouteError, ConfigError, RecursionError,
 * CliUsageError, or this module's own CmdNotFoundError) to its §11 numeric exit code.
 *
 * Notes on entries that are not 1:1 with a distinct upstream code today:
 *  - EXPLICIT_MODEL_UNAVAILABLE / NO_ELIGIBLE_MODEL / MAX_COST_EXCEEDED come from
 *    src/router/select.ts (RouteError), which is outside this remediation wave's file
 *    ownership (see AGENTS ownership list) and was not changed here.
 *  - "invalid or stale pricing" (12) and "capability mismatch" (20) do not have a
 *    dedicated RouteError/ConfigError code upstream today: a pricing-staleness or
 *    required-capability rejection that empties the eligible set surfaces as the same
 *    generic NO_ELIGIBLE_MODEL as a quality-floor rejection (see router/eligibility.ts).
 *    Distinguishing them would require a code change in router/select.ts or
 *    router/eligibility.ts, which this wave does not own. They are reserved here (and
 *    documented) rather than silently omitted, so a future change that adds a distinct
 *    upstream code has an unambiguous exit code to land on.
 *  - "unsafe permission request blocked" (32) and "live test unavailable" (40) are
 *    likewise reserved: no current call site throws a typed error with those codes
 *    (unsafe-yolo is only ever warned about via warnUnsafeYolo(), never blocked; live
 *    tests are gated by CCROUTE_LIVE/vitest.live.config.ts, not by a CLI code path).
 */
export const ERROR_CODE_EXIT_MAP: Record<string, ExitCode> = {
  CLI_USAGE_INVALID: EXIT.INVALID_CLI_USAGE,
  CONFIG_INVALID: EXIT.CONFIG_INVALID,
  RECURSION_BLOCKED: EXIT.RECURSIVE_INVOCATION_BLOCKED,
  EXPLICIT_MODEL_UNAVAILABLE: EXIT.MODEL_UNAVAILABLE,
  NO_ELIGIBLE_MODEL: EXIT.NO_ELIGIBLE_ROUTE,
  MAX_COST_EXCEEDED: EXIT.BUDGET_EXCEEDED,
  DIRTY_WORKTREE: EXIT.REPOSITORY_SAFETY_VIOLATION,
  CMD_NOT_FOUND: EXIT.MODEL_UNAVAILABLE,
};

/** Fallback for any error without a recognized `.code` — never a bare "1". */
export function exitCodeForErrorCode(code: string | undefined): ExitCode {
  if (!code) return EXIT.INTERNAL_INVARIANT_FAILURE;
  return ERROR_CODE_EXIT_MAP[code] ?? EXIT.INTERNAL_INVARIANT_FAILURE;
}

/**
 * §11 reconciliation of orchestration/orchestrator.ts's own (pre-existing, out-of-ownership
 * for this wave) numeric OrchestrateResult.exitCode values onto the taxonomy above.
 * orchestrator.ts returns ad hoc small integers (0,2,3,4,5,6,7,8) keyed to its internal
 * `status` string, but that status string is NOT part of OrchestrateResult's public shape
 * (only `exitCode`, `summary`, and `blockedReason` are) — so cli.ts cannot switch on it
 * directly without editing orchestrator.ts, which this wave does not own.
 *
 * Unambiguous cases (unique numeric code, one status each) are mapped directly here:
 *   0 OK                                -> SUCCESS
 *   3 PLANNER_REVISION_LIMIT            -> ROLE_PROTOCOL_FAILURE (planner/advisor loop bound)
 *   5 BLOCKED (reviewer decision)       -> ROLE_PROTOCOL_FAILURE (role-protocol outcome)
 *   6 VALIDATION_FAILED                 -> SUBPROCESS_FAILURE (tsc/biome/vitest/build failed)
 *   7 ADVISOR_INDEPENDENCE_BLOCKED      -> ROLE_PROTOCOL_FAILURE
 *   8 ROLE_PACKET_TOO_LARGE             -> ROLE_PROTOCOL_FAILURE
 *
 * Codes 2 and 4 are each shared by more than one status (2: PLANNER_FAILED /
 * ADVISOR_FAILED / EXECUTOR_FAILED / REVIEWER_FAILED / PLANNER_REVISION_FAILED, all using
 * `r.exitCode || 2`; 4: REPAIR_LIMIT and REPAIR_FAILED) — see mapOrchestrateExit, which
 * disambiguates those two using the `blockedReason` text that IS part of the public
 * OrchestrateResult shape.
 */
export const ORCHESTRATOR_EXIT_MAP: Record<number, ExitCode> = {
  0: EXIT.SUCCESS,
  3: EXIT.ROLE_PROTOCOL_FAILURE,
  5: EXIT.ROLE_PROTOCOL_FAILURE,
  6: EXIT.SUBPROCESS_FAILURE,
  7: EXIT.ROLE_PROTOCOL_FAILURE,
  8: EXIT.ROLE_PROTOCOL_FAILURE,
};

/**
 * Resolves the §11 exit code for an OrchestrateResult, given its raw `exitCode` and
 * `blockedReason`. See ORCHESTRATOR_EXIT_MAP for the unambiguous cases; the checks below
 * disambiguate exit codes 2 and 4 (each shared by more than one orchestrator status) using
 * blockedReason text produced by orchestrator.ts's own runRole()/finalize() call sites.
 */
export function mapOrchestrateExit(exitCode: number, blockedReason?: string): ExitCode {
  if (blockedReason === "timeout") return EXIT.TIMEOUT;
  if (blockedReason?.startsWith("role result validation failed twice")) {
    return EXIT.INVALID_CHILD_OUTPUT;
  }
  if (blockedReason?.startsWith("maxRepairs=")) return EXIT.ROLE_PROTOCOL_FAILURE;
  const mapped = ORCHESTRATOR_EXIT_MAP[exitCode];
  if (mapped !== undefined) return mapped;
  // Remaining case: exitCode 2 or 4 with a real (nonzero) child process exit code and no
  // recognized blockedReason marker — the child process itself failed.
  return EXIT.SUBPROCESS_FAILURE;
}
