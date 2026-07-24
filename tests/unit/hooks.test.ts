import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function runHook(script: string, env: NodeJS.ProcessEnv, stdin: string) {
  return spawnSync(process.execPath, [join(root, "hooks", script)], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: false,
  });
}

describe("hooks", () => {
  it("allows normal session", () => {
    const r = runHook(
      "child-recursion-guard.mjs",
      { CCROUTE_CHILD: "0" },
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_display_name: "SHELL",
        tool_input: { command: "ccroute decide hi" },
      }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout || "{}");
    expect(out.hookSpecificOutput?.permissionDecision).not.toBe("deny");
  });

  it("denies child recursion to ccroute", () => {
    const r = runHook(
      "child-recursion-guard.mjs",
      { CCROUTE_CHILD: "1" },
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_display_name: "SHELL",
        tool_input: { command: "ccroute orchestrate stuff" },
      }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("handles malformed hook input", () => {
    const r = runHook("child-recursion-guard.mjs", { CCROUTE_CHILD: "1" }, "not-json{");
    expect(r.status).toBe(0);
  });

  it("session start injects context for child", () => {
    const r = runHook(
      "child-session-context.mjs",
      { CCROUTE_CHILD: "1", CCROUTE_ROLE: "planner", CCROUTE_RUN_ID: "abc", CCROUTE_DEPTH: "1" },
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/bounded ccroute/i);
  });
});
