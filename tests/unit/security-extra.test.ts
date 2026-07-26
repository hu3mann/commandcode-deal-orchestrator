import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDefaultRoutingConfig } from "../../src/config/defaults.js";
import { loadConfig } from "../../src/config/loader.js";
import { ConfigError, mergeConfigs } from "../../src/config/merge.js";
import { resolveCmdPath } from "../../src/discovery/commandcode-cli.js";
import { buildCmdArgv } from "../../src/security/command-policy.js";
import {
  assertCcrouteEntryAllowed,
  assertNotRecursive,
  childEnv,
  readDepth,
} from "../../src/security/recursion-guard.js";

// Deterministically make the PATH-lookup step in resolveCmdPath fail, so tests can
// exercise the explicit-path validation branch regardless of what "cmd" binaries
// happen to be installed on the host running the test suite.
const NO_CMD_ON_PATH: NodeJS.ProcessEnv = { PATH: "/nonexistent-ccroute-test-path" };

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

  it("buildCmdArgv rejects write-bypass via extraArgs", () => {
    expect(() => buildCmdArgv({ model: "xai/grok-4.5", extraArgs: ["--auto-accept"] })).toThrow(
      /write-bypass/,
    );
    expect(() => buildCmdArgv({ model: "xai/grok-4.5", extraArgs: ["--yolo"] })).toThrow(
      /write-bypass/,
    );
  });

  it("assertNotRecursive allows depth 0-1", () => {
    expect(() => assertNotRecursive({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertNotRecursive({ CCROUTE_DEPTH: "1" } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertNotRecursive({ CCROUTE_DEPTH: "3" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("readDepth treats a malformed value as already-nested (fail closed), not as depth 0", () => {
    const d = readDepth({ CCROUTE_DEPTH: "nope" } as NodeJS.ProcessEnv);
    // Deliberate design choice (see recursion-guard.ts): a present-but-unparsable
    // CCROUTE_DEPTH must never be treated as "fresh entry" — that would be a bypass.
    expect(d).toBeGreaterThan(1);
    expect(() => assertNotRecursive({ CCROUTE_DEPTH: "nope" } as NodeJS.ProcessEnv)).toThrow();
    expect(() =>
      assertCcrouteEntryAllowed({ CCROUTE_DEPTH: "nope" } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it("readDepth still returns 0 when CCROUTE_DEPTH is genuinely absent", () => {
    expect(readDepth({} as NodeJS.ProcessEnv)).toBe(0);
  });

  it("childEnv accumulates depth from parent", () => {
    const e = childEnv("executor", "run-2", 1);
    expect(e.CCROUTE_DEPTH).toBe("2");
    expect(e.CCROUTE_CHILD).toBe("1");
  });
});

describe("cmdPath project-scope config rejection (CCROUTE-001 exploit fix)", () => {
  it("mergeConfigs rejects cmdPath supplied by project-scope config", () => {
    const defaults = loadDefaultRoutingConfig();
    expect(() => mergeConfigs(defaults, undefined, { cmdPath: "./evil.sh" })).toThrow(ConfigError);
    expect(() => mergeConfigs(defaults, undefined, { cmdPath: "./evil.sh" })).toThrow(
      /project-scope/i,
    );
  });

  it("mergeConfigs allows cmdPath supplied by user-scope config", () => {
    const defaults = loadDefaultRoutingConfig();
    expect(() =>
      mergeConfigs(defaults, { cmdPath: "/usr/local/bin/cmd" }, undefined),
    ).not.toThrow();
  });

  it("mergeConfigs allows cmdPath supplied via CLI overrides", () => {
    const defaults = loadDefaultRoutingConfig();
    expect(() =>
      mergeConfigs(defaults, undefined, undefined, { cmdPath: "/usr/local/bin/cmd" }),
    ).not.toThrow();
  });

  it("end-to-end: loadConfig rejects a project .commandcode/deal-router.yaml with cmdPath (confirmed exploit)", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ccroute-project-"));
    mkdirSync(join(projectDir, ".commandcode"), { recursive: true });
    writeFileSync(join(projectDir, ".commandcode", "deal-router.yaml"), "cmdPath: ./evil.sh\n");
    expect(() => loadConfig({ cwd: projectDir })).toThrow(ConfigError);
    expect(() => loadConfig({ cwd: projectDir })).toThrow(/project-scope/i);
  });

  it("rejects other security-sensitive keys smuggled in at the top level (not just under security:)", () => {
    const defaults = loadDefaultRoutingConfig();
    // Previously this guard only fired when the key path contained the literal
    // substring "security"; a top-level key bypassed it entirely.
    expect(() => mergeConfigs(defaults, { apiKey: "sk-should-not-be-config" })).toThrow(
      ConfigError,
    );
  });
});

describe("resolveCmdPath hardening (CCROUTE-001 exploit fix)", () => {
  it("rejects a relative path outright", () => {
    expect(() => resolveCmdPath("./evil.sh", NO_CMD_ON_PATH)).toThrow(/absolute/i);
  });

  it("rejects a directory (not a regular file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-dir-"));
    expect(() => resolveCmdPath(dir, NO_CMD_ON_PATH)).toThrow();
  });

  it("rejects a non-executable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-noexec-"));
    const file = join(dir, "not-executable.sh");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o644);
    expect(() => resolveCmdPath(file, NO_CMD_ON_PATH)).toThrow();
  });

  it("rejects an executable that resolves inside the current project directory (the confirmed exploit)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-proj-"));
    const file = join(dir, "evil.sh");
    writeFileSync(file, "#!/bin/sh\necho pwned\n");
    chmodSync(file, 0o755);
    const cwdBefore = process.cwd();
    process.chdir(dir);
    try {
      expect(() => resolveCmdPath(file, NO_CMD_ON_PATH)).toThrow(/project directory/i);
    } finally {
      process.chdir(cwdBefore);
    }
  });

  it("accepts a valid absolute executable file outside the project directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-ok-"));
    const file = join(dir, "cmd-stub.sh");
    writeFileSync(file, "#!/bin/sh\necho ok\n");
    chmodSync(file, 0o755);
    expect(resolveCmdPath(file, NO_CMD_ON_PATH)).toBe(file);
  });
});
