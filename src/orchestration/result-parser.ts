import { z } from "zod";

export const RoleResultSchema = z.object({
  schemaVersion: z.literal(1),
  role: z.enum(["planner", "advisor", "executor", "reviewer", "repair"]),
  status: z.enum(["success", "failure", "blocked"]),
  summary: z.string(),
  artifacts: z.array(z.unknown()).default([]),
  findings: z.array(z.unknown()).default([]),
  nextAction: z.string().optional(),
  decision: z
    .enum(["PLAN_APPROVED", "PLAN_REQUIRES_REVISION", "ACCEPT", "REPAIR_REQUIRED", "BLOCKED"])
    .optional(),
});
export type RoleResult = z.infer<typeof RoleResultSchema>;

const BEGIN = "BEGIN_CCROUTE_RESULT";
const END = "END_CCROUTE_RESULT";

export function extractEnvelope(text: string): string | null {
  const start = text.lastIndexOf(BEGIN);
  if (start === -1) return null;
  const after = text.slice(start + BEGIN.length);
  const end = after.indexOf(END);
  if (end === -1) return null;
  return after.slice(0, end).trim();
}

export function parseRoleResult(
  text: string,
): { ok: true; result: RoleResult } | { ok: false; error: string } {
  const raw = extractEnvelope(text);
  if (!raw) {
    // try whole text as JSON
    try {
      const parsed = RoleResultSchema.safeParse(JSON.parse(text.trim()));
      if (parsed.success) return { ok: true, result: parsed.data };
    } catch {
      /* fallthrough */
    }
    return { ok: false, error: "No BEGIN_CCROUTE_RESULT envelope found" };
  }
  try {
    const json = JSON.parse(raw);
    const parsed = RoleResultSchema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => i.message).join("; "),
      };
    }
    return { ok: true, result: parsed.data };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}` };
  }
}

export function formatRepairPrompt(error: string): string {
  return `Your previous response was not a valid ccroute envelope. Error: ${error}

Respond with ONLY:

BEGIN_CCROUTE_RESULT
{ "schemaVersion": 1, "role": "<role>", "status": "success", "summary": "...", "artifacts": [], "findings": [], "nextAction": "..." }
END_CCROUTE_RESULT
`;
}
