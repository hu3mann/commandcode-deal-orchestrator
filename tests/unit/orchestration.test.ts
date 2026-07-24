import { describe, expect, it } from "vitest";
import { classifyTask } from "../../src/classifier/deterministic.js";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { shouldOrchestrate } from "../../src/orchestration/orchestrator.js";
import {
  extractEnvelope,
  formatRepairPrompt,
  parseRoleResult,
} from "../../src/orchestration/result-parser.js";
import { validateRoleSemantics } from "../../src/orchestration/validation.js";

const good = `
some prose
BEGIN_CCROUTE_RESULT
{"schemaVersion":1,"role":"planner","status":"success","summary":"ok","artifacts":[],"findings":[],"nextAction":"go"}
END_CCROUTE_RESULT
`;

describe("orchestration protocol", () => {
  it("extracts envelope", () => {
    expect(extractEnvelope(good)).toContain("schemaVersion");
  });

  it("parses valid result", () => {
    const r = parseRoleResult(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.role).toBe("planner");
  });

  it("fails invalid envelope", () => {
    const r = parseRoleResult("no envelope here");
    expect(r.ok).toBe(false);
  });

  it("format repair prompt is bounded", () => {
    expect(formatRepairPrompt("bad json")).toContain("BEGIN_CCROUTE_RESULT");
  });

  it("validates advisor decision", () => {
    const r = parseRoleResult(`BEGIN_CCROUTE_RESULT
{"schemaVersion":1,"role":"advisor","status":"success","summary":"x","artifacts":[],"findings":[],"decision":"PLAN_APPROVED"}
END_CCROUTE_RESULT`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateRoleSemantics("advisor", r.result).ok).toBe(true);
    }
  });

  it("skips orchestration for read_only", () => {
    const cfg = loadDefaultRoutingConfig();
    const t = classifyTask("Explain the module");
    expect(shouldOrchestrate(t, cfg)).toBe(false);
  });

  it("orchestrates complex_build", () => {
    const cfg = loadDefaultRoutingConfig();
    const t = classifyTask("Multi-file refactor migration across services");
    expect(shouldOrchestrate(t, cfg)).toBe(true);
  });
});
