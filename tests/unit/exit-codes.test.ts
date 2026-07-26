import { describe, expect, it } from "vitest";
import {
  CliUsageError,
  ERROR_CODE_EXIT_MAP,
  EXIT,
  ORCHESTRATOR_EXIT_MAP,
  exitCodeForErrorCode,
  mapOrchestrateExit,
} from "../../src/cli/exit-codes.js";

describe("§11 exit-code taxonomy", () => {
  it("CliUsageError carries CLI_USAGE_INVALID and maps to exit 2", () => {
    const e = new CliUsageError("bad usage");
    expect(e.code).toBe("CLI_USAGE_INVALID");
    expect(exitCodeForErrorCode(e.code)).toBe(EXIT.INVALID_CLI_USAGE);
    expect(EXIT.INVALID_CLI_USAGE).toBe(2);
  });

  it("maps every known error code to its documented numeric exit code", () => {
    expect(exitCodeForErrorCode("CONFIG_INVALID")).toBe(10);
    expect(exitCodeForErrorCode("RECURSION_BLOCKED")).toBe(31);
    expect(exitCodeForErrorCode("EXPLICIT_MODEL_UNAVAILABLE")).toBe(11);
    expect(exitCodeForErrorCode("NO_ELIGIBLE_MODEL")).toBe(13);
    expect(exitCodeForErrorCode("MAX_COST_EXCEEDED")).toBe(14);
    expect(exitCodeForErrorCode("DIRTY_WORKTREE")).toBe(30);
    expect(exitCodeForErrorCode("CMD_NOT_FOUND")).toBe(11);
  });

  it("falls back to INTERNAL_INVARIANT_FAILURE (50), never a bare 1, for an unmapped code", () => {
    expect(exitCodeForErrorCode("SOMETHING_NEVER_SEEN_BEFORE")).toBe(
      EXIT.INTERNAL_INVARIANT_FAILURE,
    );
    expect(exitCodeForErrorCode(EXIT.INTERNAL_INVARIANT_FAILURE.toString())).toBe(
      EXIT.INTERNAL_INVARIANT_FAILURE,
    );
    expect(EXIT.INTERNAL_INVARIANT_FAILURE).toBe(50);
  });

  it("falls back to INTERNAL_INVARIANT_FAILURE when there is no code at all", () => {
    expect(exitCodeForErrorCode(undefined)).toBe(EXIT.INTERNAL_INVARIANT_FAILURE);
  });

  it("every value in ERROR_CODE_EXIT_MAP is a value defined in EXIT", () => {
    const exitValues = new Set(Object.values(EXIT));
    for (const v of Object.values(ERROR_CODE_EXIT_MAP)) {
      expect(exitValues.has(v)).toBe(true);
    }
  });
});

describe("orchestrator exit-code reconciliation", () => {
  it("maps the unambiguous orchestrator codes directly", () => {
    expect(mapOrchestrateExit(0)).toBe(EXIT.SUCCESS);
    expect(mapOrchestrateExit(3)).toBe(EXIT.ROLE_PROTOCOL_FAILURE); // PLANNER_REVISION_LIMIT
    expect(mapOrchestrateExit(5)).toBe(EXIT.ROLE_PROTOCOL_FAILURE); // reviewer BLOCKED
    expect(mapOrchestrateExit(6)).toBe(EXIT.SUBPROCESS_FAILURE); // VALIDATION_FAILED
    expect(mapOrchestrateExit(7)).toBe(EXIT.ROLE_PROTOCOL_FAILURE); // ADVISOR_INDEPENDENCE_BLOCKED
    expect(mapOrchestrateExit(8)).toBe(EXIT.ROLE_PROTOCOL_FAILURE); // ROLE_PACKET_TOO_LARGE
  });

  it("disambiguates exit code 2/4 (timeout) via blockedReason", () => {
    expect(mapOrchestrateExit(2, "timeout")).toBe(EXIT.TIMEOUT);
    expect(mapOrchestrateExit(4, "timeout")).toBe(EXIT.TIMEOUT);
  });

  it("disambiguates exit code 2 (envelope/semantic validation exhausted) via blockedReason", () => {
    expect(mapOrchestrateExit(2, "role result validation failed twice: no envelope found")).toBe(
      EXIT.INVALID_CHILD_OUTPUT,
    );
  });

  it("disambiguates exit code 4 (REPAIR_LIMIT) via blockedReason", () => {
    expect(mapOrchestrateExit(4, "maxRepairs=1 exhausted; reviewer still requires repair")).toBe(
      EXIT.ROLE_PROTOCOL_FAILURE,
    );
  });

  it("falls back to SUBPROCESS_FAILURE for a real nonzero child exit code with no marker", () => {
    expect(mapOrchestrateExit(2)).toBe(EXIT.SUBPROCESS_FAILURE);
    expect(mapOrchestrateExit(4)).toBe(EXIT.SUBPROCESS_FAILURE);
    expect(mapOrchestrateExit(2, undefined)).toBe(EXIT.SUBPROCESS_FAILURE);
  });

  it("every ORCHESTRATOR_EXIT_MAP value is a value defined in EXIT", () => {
    const exitValues = new Set(Object.values(EXIT));
    for (const v of Object.values(ORCHESTRATOR_EXIT_MAP)) {
      expect(exitValues.has(v)).toBe(true);
    }
  });
});
