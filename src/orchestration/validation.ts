import type { RoleResult } from "./result-parser.js";
import type { RoleName } from "./roles.js";

export function validateRoleSemantics(
  role: RoleName,
  result: RoleResult,
): { ok: true } | { ok: false; error: string } {
  if (result.role !== role && result.role !== "repair") {
    return { ok: false, error: `role mismatch: expected ${role}, got ${result.role}` };
  }
  if (role === "advisor" && result.decision) {
    if (!["PLAN_APPROVED", "PLAN_REQUIRES_REVISION"].includes(result.decision)) {
      return { ok: false, error: `invalid advisor decision ${result.decision}` };
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
