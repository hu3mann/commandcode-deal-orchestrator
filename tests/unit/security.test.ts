import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeModelId,
  buildCmdArgv,
  warnUnsafeYolo,
} from "../../src/security/command-policy.js";
import { assertPathInsideRoot } from "../../src/security/path-policy.js";
import {
  RecursionError,
  assertCcrouteEntryAllowed,
  childEnv,
  readDepth,
} from "../../src/security/recursion-guard.js";
import { redactText } from "../../src/telemetry/redact.js";

describe("security", () => {
  it("rejects newline in model id", () => {
    expect(() => assertSafeModelId("foo\nbar")).toThrow();
  });

  it("rejects shell metacharacters in model id", () => {
    expect(() => assertSafeModelId("x; rm -rf /")).toThrow();
  });

  it("buildCmdArgv never uses shell string — returns array", () => {
    const argv = buildCmdArgv({
      model: "deepseek/deepseek-v4-flash",
      autoAccept: false,
    });
    expect(Array.isArray(argv)).toBe(true);
    expect(argv).not.toContain("--auto-accept");
    expect(argv).toContain("--model");
  });

  it("includes auto-accept only when requested", () => {
    const argv = buildCmdArgv({
      model: "deepseek/deepseek-v4-flash",
      autoAccept: true,
    });
    expect(argv).toContain("--auto-accept");
  });

  it("blocks recursion at depth 2", () => {
    expect(() => assertCcrouteEntryAllowed({ CCROUTE_DEPTH: "2" } as NodeJS.ProcessEnv)).toThrow(
      RecursionError,
    );
  });

  it("blocks ccroute entry when already a child", () => {
    expect(() =>
      assertCcrouteEntryAllowed({ CCROUTE_CHILD: "1", CCROUTE_DEPTH: "1" } as NodeJS.ProcessEnv),
    ).toThrow(RecursionError);
  });

  it("child env sets depth 1", () => {
    const e = childEnv("planner", "run-1", 0);
    expect(e.CCROUTE_CHILD).toBe("1");
    expect(e.CCROUTE_DEPTH).toBe("1");
    expect(readDepth(e)).toBe(1);
  });

  it("warns on unsafe yolo", () => {
    expect(warnUnsafeYolo()).toMatch(/WARNING/);
  });

  it("path policy blocks escape", () => {
    const root = process.cwd();
    expect(() => assertPathInsideRoot("../outside", root)).toThrow(/escapes/i);
    expect(assertPathInsideRoot(join(root, "package.json"), root)).toContain("package.json");
  });

  it("redacts secrets", () => {
    expect(redactText("api_key=sk-abcdef1234567890")).toContain("[REDACTED]");
  });
});
