import { describe, expect, it } from "vitest";
import { buildCmdArgv } from "../../src/security/command-policy.js";
import { wouldAutoAccept } from "../../src/subprocess/commandcode.js";

describe("apply authorization", () => {
  it("child argv excludes --auto-accept without apply", () => {
    expect(wouldAutoAccept(false)).toBe(false);
    const argv = buildCmdArgv({
      model: "deepseek/deepseek-v4-flash",
      autoAccept: wouldAutoAccept(false),
    });
    expect(argv.includes("--auto-accept")).toBe(false);
  });

  it("child argv includes --auto-accept with apply", () => {
    expect(wouldAutoAccept(true)).toBe(true);
    const argv = buildCmdArgv({
      model: "deepseek/deepseek-v4-flash",
      autoAccept: wouldAutoAccept(true),
    });
    expect(argv.includes("--auto-accept")).toBe(true);
  });

  it("task text is not placed in argv", () => {
    const task = "fix; rm -rf / $(evil)";
    const argv = buildCmdArgv({ model: "deepseek/deepseek-v4-flash" });
    expect(argv.join(" ")).not.toContain(task);
    expect(argv.every((a) => !a.includes("rm -rf"))).toBe(true);
  });
});
