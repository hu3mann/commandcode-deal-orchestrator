import { describe, expect, it } from "vitest";
import { RouteError } from "../../src/router/select.js";
import { ensureGitSafety } from "../../src/security/git-safety.js";

describe("ensureGitSafety", () => {
  it("skips when not applying", () => {
    expect(() =>
      ensureGitSafety(false, false, {
        getStatus: () => ({ status: 0, stdout: " M src/cli.ts\n" }),
      }),
    ).not.toThrow();
  });

  it("allows clean worktree with apply", () => {
    expect(() =>
      ensureGitSafety(true, false, {
        getStatus: () => ({ status: 0, stdout: "" }),
      }),
    ).not.toThrow();
  });

  it("blocks dirty worktree for run --apply without --allow-dirty", () => {
    expect(() =>
      ensureGitSafety(true, false, {
        context: "run",
        getStatus: () => ({ status: 0, stdout: " M src/cli.ts\n" }),
      }),
    ).toThrow(RouteError);

    try {
      ensureGitSafety(true, false, {
        context: "run",
        getStatus: () => ({ status: 0, stdout: "?? untracked.txt\n" }),
      });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).code).toBe("DIRTY_WORKTREE");
      expect((e as Error).message).toMatch(/run --apply/);
      expect((e as Error).message).toMatch(/--allow-dirty/);
    }
  });

  it("blocks dirty worktree for orchestrate --apply without --allow-dirty", () => {
    try {
      ensureGitSafety(true, false, {
        context: "orchestrate",
        getStatus: () => ({ status: 0, stdout: "A  staged.ts\n" }),
      });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RouteError);
      expect((e as RouteError).code).toBe("DIRTY_WORKTREE");
      expect((e as Error).message).toMatch(/orchestration --apply/);
    }
  });

  it("allows dirty worktree when --allow-dirty is set", () => {
    expect(() =>
      ensureGitSafety(true, true, {
        context: "run",
        getStatus: () => ({ status: 0, stdout: " M dirty.ts\n" }),
      }),
    ).not.toThrow();
  });

  it("skips when git status fails (not a repo)", () => {
    expect(() =>
      ensureGitSafety(true, false, {
        getStatus: () => ({ status: 128, stdout: "fatal: not a git repository\n" }),
      }),
    ).not.toThrow();
  });

  it("treats whitespace-only porcelain as clean", () => {
    expect(() =>
      ensureGitSafety(true, false, {
        getStatus: () => ({ status: 0, stdout: "\n  \n" }),
      }),
    ).not.toThrow();
  });
});
