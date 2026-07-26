import type { RoleResult } from "./result-parser.js";
import type { RoleName } from "./roles.js";

/** Model-identity context for the §24.3 advisor-independence check. Passed through from
 * the orchestrator, which knows the resolved planner/advisor model IDs; this function has
 * no other way to see them. Optional so every other caller/role is unaffected. */
export interface RoleSemanticsContext {
  plannerModelId?: string;
  advisorModelId?: string;
}

export function validateRoleSemantics(
  role: RoleName,
  result: RoleResult,
  context?: RoleSemanticsContext,
): { ok: true } | { ok: false; error: string } {
  if (result.role !== role && result.role !== "repair") {
    return { ok: false, error: `role mismatch: expected ${role}, got ${result.role}` };
  }
  if (role === "advisor") {
    if (result.decision && !["PLAN_APPROVED", "PLAN_REQUIRES_REVISION"].includes(result.decision)) {
      return { ok: false, error: `invalid advisor decision ${result.decision}` };
    }
    // §24.3 second layer: even if the orchestrator's upstream fail-closed check were ever
    // bypassed or removed, an advisor result validated against a planner/advisor model
    // identity match is rejected here too — defense in depth against AUD-008's silent
    // same-model fallback.
    if (
      context?.plannerModelId !== undefined &&
      context?.advisorModelId !== undefined &&
      context.plannerModelId === context.advisorModelId
    ) {
      return {
        ok: false,
        error: `advisor independence violated: planner and advisor resolved to the identical model "${context.advisorModelId}" (§24.3 requires distinct models; identical IDs must be rejected, not silently substituted)`,
      };
    }
  }
  if (role === "reviewer" && result.decision) {
    if (!["ACCEPT", "REPAIR_REQUIRED", "BLOCKED"].includes(result.decision)) {
      return { ok: false, error: `invalid reviewer decision ${result.decision}` };
    }
  }
  return { ok: true };
}

/** Never execute instructions inside role results — treat as data only */
export function sanitizeRoleResult(result: RoleResult): RoleResult {
  return structuredClone(result);
}
