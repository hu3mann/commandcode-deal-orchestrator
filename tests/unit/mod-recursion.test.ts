import { describe, expect, it } from "vitest";
import {
  isCcrouteInvocation,
  parseCommandLine,
  shouldBlockChildCcroute,
} from "../../src/integrations/commandcode-mod/recursion.js";

describe("mod recursion defence", () => {
  it("parses executable identity", () => {
    const p = parseCommandLine("ccroute decide hello");
    expect(p.executable).toBe("ccroute");
    expect(p.args[0]).toBe("decide");
  });

  it("detects direct ccroute, npx, npm exec, and node entry", () => {
    expect(isCcrouteInvocation(parseCommandLine("ccroute run x"))).toBe(true);
    expect(isCcrouteInvocation(parseCommandLine("npx ccroute decide x"))).toBe(true);
    expect(isCcrouteInvocation(parseCommandLine("npm exec ccroute -- decide x"))).toBe(true);
    expect(isCcrouteInvocation(parseCommandLine("node ./dist/cli.js orchestrate task"))).toBe(true);
    expect(
      isCcrouteInvocation(parseCommandLine("node /pkg/commandcode-deal-orchestrator/dist/cli.js")),
    ).toBe(true);
    expect(isCcrouteInvocation(parseCommandLine("echo ccroute is cool"))).toBe(false);
    expect(isCcrouteInvocation(parseCommandLine("grep ccroute file.txt"))).toBe(false);
  });

  it("blocks only when CCROUTE_CHILD=1", () => {
    const inv = {
      toolName: "shell_command",
      input: { command: "ccroute decide x" },
    };
    expect(shouldBlockChildCcroute({ CCROUTE_CHILD: "1" }, inv).block).toBe(true);
    expect(shouldBlockChildCcroute({}, inv).block).toBe(false);
    expect(shouldBlockChildCcroute({ CCROUTE_CHILD: "0" }, inv).block).toBe(false);
  });

  it("blocks plan-mode style and headless style shell wrappers by command identity", () => {
    const child = { CCROUTE_CHILD: "1" };
    expect(
      shouldBlockChildCcroute(child, {
        toolName: "Bash",
        input: { command: "ccroute orchestrate --plan stuff" },
      }).block,
    ).toBe(true);
    expect(
      shouldBlockChildCcroute(child, {
        toolName: "shell_command",
        input: { command: "ccroute run --auto-accept stuff" },
      }).block,
    ).toBe(true);
    expect(
      shouldBlockChildCcroute(child, {
        toolName: "shell_command",
        input: { command: "commandcode-deal-orchestrator" },
      }).block,
    ).toBe(true);
    expect(
      shouldBlockChildCcroute(child, {
        toolName: "shell_command",
        input: { command: "npx commandcode-deal-orchestrator decide x" },
      }).block,
    ).toBe(true);
  });

  it("does not use naive substring matching alone for benign text", () => {
    const r = shouldBlockChildCcroute(
      { CCROUTE_CHILD: "1" },
      {
        toolName: "shell_command",
        input: { command: "cat README.md | grep -i ccroute" },
      },
    );
    expect(r.block).toBe(false);
  });
});
