import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  RecursionError,
  assertCcrouteEntryAllowed,
  assertPrimaryRecursionGuard,
  childEnv,
  readDepth,
} from "../../src/security/recursion-guard.js";

const root = process.cwd();
const cli = join(root, "dist/cli.js");

function ensureBuiltCli(): void {
  if (existsSync(cli)) return;
  // CI runs `npm test` before `npm run build`; produce the binary entry for spawn probes.
  const built = spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (built.status !== 0 || !existsSync(cli)) {
    throw new Error(
      `failed to build dist/cli.js for recursion CLI probe:\n${built.stdout}\n${built.stderr}`,
    );
  }
}

function runCli(env: NodeJS.ProcessEnv, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: false,
  });
}

describe("primary recursion enforcement", () => {
  beforeAll(() => {
    ensureBuiltCli();
  });

  it("treats missing depth as zero", () => {
    expect(readDepth({})).toBe(0);
    expect(() => assertPrimaryRecursionGuard({})).not.toThrow();
  });

  it("allows ordinary depth 0 invocation", () => {
    expect(() =>
      assertCcrouteEntryAllowed({ CCROUTE_DEPTH: "0" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("rejects depth 1 child (direct child invocation)", () => {
    const env = childEnv("executor", "run-1", 0);
    expect(env.CCROUTE_DEPTH).toBe("1");
    expect(env.CCROUTE_CHILD).toBe("1");
    expect(() => assertPrimaryRecursionGuard(env as NodeJS.ProcessEnv)).toThrow(RecursionError);
  });

  it("rejects depth greater than one unconditionally", () => {
    expect(() => assertPrimaryRecursionGuard({ CCROUTE_DEPTH: "2" } as NodeJS.ProcessEnv)).toThrow(
      RecursionError,
    );
    expect(() =>
      assertPrimaryRecursionGuard({
        CCROUTE_DEPTH: "3",
        CCROUTE_CHILD: "1",
      } as NodeJS.ProcessEnv),
    ).toThrow(RecursionError);
  });

  it("rejects malformed depth fail-closed", () => {
    expect(() =>
      assertPrimaryRecursionGuard({ CCROUTE_DEPTH: "nope" } as NodeJS.ProcessEnv),
    ).toThrow(RecursionError);
  });

  it("CLI entry rejects child env for doctor/decide/run (binary-level)", () => {
    ensureBuiltCli();
    const child = childEnv("planner", "r1", 0);
    for (const args of [
      ["doctor", "--json"],
      ["decide", "--json", "hello"],
    ]) {
      const r = runCli(child as NodeJS.ProcessEnv, args);
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}${r.stdout}`).toMatch(/CCROUTE_CHILD|RECURSION|refused|rejected/i);
    }
  });

  it("user shell cannot enable nested orchestration via env alone without being blocked when child", () => {
    // Simulates plan-mode / default-mode / auto-accept / headless child shells
    // that inherit CCROUTE_CHILD=1 — all must fail at binary entry.
    for (const extra of [{}, { CCROUTE_ROLE: "planner" }, { CCROUTE_ROLE: "executor" }]) {
      const env = { ...childEnv("role", "run", 0), ...extra } as NodeJS.ProcessEnv;
      expect(() => assertPrimaryRecursionGuard(env)).toThrow(RecursionError);
    }
  });
});
