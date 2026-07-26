import { describe, expect, it } from "vitest";
import * as pkg from "../../src/index.js";

/**
 * src/index.ts is a pure re-export barrel (the package's public `commandcode-deal-
 * orchestrator` entry point, see package.json#exports). There is no branching logic to
 * test — importing it and asserting every named export is present and of the expected
 * kind is sufficient to prove the module loads cleanly end-to-end.
 */
describe("src/index.ts public API surface", () => {
  it("re-exports every documented function and class", () => {
    expect(typeof pkg.classifyTask).toBe("function");
    expect(typeof pkg.parseTaskMarkers).toBe("function");
    expect(typeof pkg.loadConfig).toBe("function");
    expect(typeof pkg.validateConfigFile).toBe("function");
    expect(typeof pkg.calculateRequestCost).toBe("function");
    expect(typeof pkg.resolveEffectiveRates).toBe("function");
    expect(typeof pkg.selectRoute).toBe("function");
    expect(typeof pkg.RouteError).toBe("function");
    expect(typeof pkg.formatExplain).toBe("function");
    expect(typeof pkg.spawnCommandCode).toBe("function");
    expect(typeof pkg.orchestrate).toBe("function");
    expect(typeof pkg.shouldOrchestrate).toBe("function");
    expect(typeof pkg.parseRoleResult).toBe("function");
    expect(typeof pkg.assertCcrouteEntryAllowed).toBe("function");
    expect(typeof pkg.assertPrimaryRecursionGuard).toBe("function");
    expect(typeof pkg.assertNotRecursive).toBe("function");
    expect(typeof pkg.RecursionError).toBe("function");
    expect(typeof pkg.childEnv).toBe("function");
    expect(typeof pkg.readDepth).toBe("function");
    expect(typeof pkg.isChildProcess).toBe("function");
    expect(typeof pkg.buildCmdArgv).toBe("function");
    expect(typeof pkg.assertSafeModelId).toBe("function");
    expect(typeof pkg.ensureGitSafety).toBe("function");
    // CommandCode Mod pure helpers (TP-CCROUTE-AUTO-001)
    expect(typeof pkg.parseRouterMarkers).toBe("function");
    expect(typeof pkg.shouldAutoRoute).toBe("function");
    expect(typeof pkg.inspectModApi).toBe("function");
    expect(typeof pkg.canRouteAutomatically).toBe("function");
    expect(typeof pkg.validateDecidePayload).toBe("function");
    expect(typeof pkg.shouldBlockChildCcroute).toBe("function");
    expect(typeof pkg.routeTypedPrompt).toBe("function");
    expect(typeof pkg.createSessionState).toBe("function");
  });
});
