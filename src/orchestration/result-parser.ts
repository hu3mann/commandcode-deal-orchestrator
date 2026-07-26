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

/** §25: exactly ONE bounded envelope must be parsed. Bytes, matching how child output is
 * measured elsewhere (maxResultBytes), not code points. */
export const DEFAULT_MAX_ENVELOPE_BYTES = 200_000;

type EnvelopeLocation =
  | { ok: true; body: string }
  | { ok: false; reason: "none" | "multiple" | "unterminated" };

/**
 * Locates the envelope body. Fails closed (reason: "multiple") when more than one
 * BEGIN_CCROUTE_RESULT marker is present, rather than silently picking the last one
 * (defect §4: `lastIndexOf` let output that echoes repository content containing a
 * plausible envelope override a genuine BLOCKED/REPAIR_REQUIRED with an injected ACCEPT).
 */
function locateEnvelope(text: string): EnvelopeLocation {
  const firstBegin = text.indexOf(BEGIN);
  if (firstBegin === -1) return { ok: false, reason: "none" };
  const secondBegin = text.indexOf(BEGIN, firstBegin + BEGIN.length);
  if (secondBegin !== -1) return { ok: false, reason: "multiple" };

  const after = text.slice(firstBegin + BEGIN.length);
  const endIdx = after.indexOf(END);
  if (endIdx === -1) return { ok: false, reason: "unterminated" };
  return { ok: true, body: after.slice(0, endIdx).trim() };
}

export function extractEnvelope(text: string): string | null {
  const loc = locateEnvelope(text);
  return loc.ok ? loc.body : null;
}

export interface ParseRoleResultOptions {
  /** Explicit size bound on the envelope body (defect §4). */
  maxEnvelopeBytes?: number;
}

export function parseRoleResult(
  text: string,
  options?: ParseRoleResultOptions,
): { ok: true; result: RoleResult } | { ok: false; error: string } {
  const maxEnvelopeBytes = options?.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES;
  const loc = locateEnvelope(text);

  if (!loc.ok) {
    if (loc.reason === "multiple") {
      return {
        ok: false,
        error:
          "Multiple BEGIN_CCROUTE_RESULT envelopes detected in role output; refusing to " +
          "select one (possible envelope injection). Exactly one bounded envelope is required.",
      };
    }
    if (loc.reason === "unterminated") {
      return {
        ok: false,
        error: "BEGIN_CCROUTE_RESULT found without a matching END_CCROUTE_RESULT",
      };
    }
    // reason === "none": try whole text as JSON (legacy fallback for models that emit
    // bare JSON with no envelope markers at all).
    try {
      const parsed = RoleResultSchema.safeParse(JSON.parse(text.trim()));
      if (parsed.success) return { ok: true, result: parsed.data };
    } catch {
      /* fallthrough */
    }
    return { ok: false, error: "No BEGIN_CCROUTE_RESULT envelope found" };
  }

  const raw = loc.body;
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes > maxEnvelopeBytes) {
    return {
      ok: false,
      error: `Envelope body is ${rawBytes} bytes, exceeding the ${maxEnvelopeBytes}-byte bound`,
    };
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
