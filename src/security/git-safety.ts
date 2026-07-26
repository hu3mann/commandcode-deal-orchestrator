import { spawnSync } from "node:child_process";
import { RouteError } from "../router/select.js";

export type GitStatusResult = {
  status: number | null;
  stdout: string;
};

/** Default porcelain status probe (shell:false). */
export function defaultGitPorcelainStatus(): GitStatusResult {
  const st = spawnSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    shell: false,
  });
  return { status: st.status, stdout: st.stdout ?? "" };
}

/**
 * Fail closed when applying writes on a dirty worktree unless --allow-dirty.
 * Applies to both single-model `run --apply` and multi-role `orchestrate --apply`.
 * Non-git directories (or git status failure) are skipped.
 */
export function ensureGitSafety(
  apply: boolean,
  allowDirty: boolean,
  options?: {
    getStatus?: () => GitStatusResult;
    context?: "run" | "orchestrate";
  },
): void {
  if (!apply) return;
  const getStatus = options?.getStatus ?? defaultGitPorcelainStatus;
  const st = getStatus();
  if (st.status !== 0) return;
  if (st.stdout.trim() && !allowDirty) {
    const ctx = options?.context === "orchestrate" ? "orchestration --apply" : "run --apply";
    throw new RouteError(
      "DIRTY_WORKTREE",
      `Dirty worktree blocked for ${ctx} (use --allow-dirty to override)`,
    );
  }
}
