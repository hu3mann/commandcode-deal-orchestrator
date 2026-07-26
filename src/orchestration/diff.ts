import { type SpawnSyncReturns, spawnSync } from "node:child_process";

/**
 * §24.6 requires the Reviewer receive the diff, not just the Executor's self-report.
 * Uses `git diff` (argv array, shell:false — same pattern as
 * src/security/git-safety.ts's `defaultGitPorcelainStatus`) and bounds the output so an
 * enormous diff cannot blow the role packet's size budget.
 */

export interface DiffSummaryResult {
  diffSummary: string;
  fileBoundaries: string[];
  truncated: boolean;
  /** False when `git` itself was unusable (not a repo, git missing, etc). */
  available: boolean;
}

type SpawnSyncFn = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: "utf8"; shell: false },
) => SpawnSyncReturns<string>;

export interface ComputeBoundedGitDiffOptions {
  cwd?: string;
  /** Bound on the diff body (the `git diff` output), in bytes. */
  maxBytes?: number;
  spawnImpl?: SpawnSyncFn;
}

const DEFAULT_MAX_DIFF_BYTES = 100_000;

export function computeBoundedGitDiff(options: ComputeBoundedGitDiffOptions): DiffSummaryResult {
  const spawnImpl = options.spawnImpl ?? (spawnSync as unknown as SpawnSyncFn);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;

  const nameOnly = spawnImpl("git", ["diff", "--name-only", "HEAD"], {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
  });
  if (nameOnly.status !== 0) {
    // Not a git repo, no HEAD commit yet, or git unavailable — not fatal, just no diff.
    return {
      diffSummary: "(no diff available: git diff --name-only failed or not a git repository)",
      fileBoundaries: [],
      truncated: false,
      available: false,
    };
  }
  const fileBoundaries = (nameOnly.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const stat = spawnImpl("git", ["diff", "--stat", "HEAD"], {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
  });
  const statOut = stat.status === 0 ? (stat.stdout ?? "") : "";

  const full = spawnImpl("git", ["diff", "HEAD"], {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
  });
  let body = full.status === 0 ? (full.stdout ?? "") : "";
  let truncated = false;
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    body = `${body.slice(0, maxBytes)}\n...[diff truncated at ${maxBytes} bytes]`;
    truncated = true;
  }

  const combined = [statOut.trim(), body.trim()].filter(Boolean).join("\n\n");
  return {
    diffSummary: combined || "(no diff: working tree matches HEAD)",
    fileBoundaries,
    truncated,
    available: true,
  };
}
