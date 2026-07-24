import { describe, expect, it } from "vitest";
import { buildCmdArgv } from "../../src/security/command-policy.js";
import {
  assertNotRecursive,
  childEnv,
  readDepth,
} from "../../src/security/recursion-guard.js";

describe("security extras", () => {
  it("buildCmdArgv includes plan yolo maxTurns trust outputFormat", () => {
    const argv = buildCmdArgv({
      model: "xai/grok-4.5",
      plan: true,
      unsafeYolo: true,
      maxTurns: 4,
      trust: true,
      outputFormat: "json",
      extraArgs: ["--verbose"],
    });
    expect(argv).toContain("--plan");
    expect(argv).toContain("--yolo");
    expect(argv).toContain("4");
    expect(argv).toContain("--trust");
    expect(argv).toContain("json");
    expect(argv).toContain("--verbose");
  });

  it("assertNotRecursive allows depth 0-1", () => {
    expect(() => assertNotRecursive({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertNotRecursive({ CCROUTE_DEPTH: "1" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertNotRecursive({ CCROUTE_DEPTH: "3" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("readDepth invalid", () => {
    expect(readDepth({ CCROUTE_DEPTH: "nope" } as NodeJS.ProcessEnv)).toBe(0);
  });

  it("childEnv accumulates depth from parent", () => {
    const e = childEnv("executor", "run-2", 1);
    expect(e.CCROUTE_DEPTH).toBe("2");
    expect(e.CCROUTE_CHILD).toBe("1");
  });
});
