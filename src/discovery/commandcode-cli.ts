import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { isAbsolute, sep } from "node:path";

export interface CmdProbe {
  path: string | null;
  version: string | null;
  helpSnippet: string | null;
  error?: string;
}

function isPathInside(childReal: string, parentReal: string): boolean {
  if (childReal === parentReal) return true;
  const prefix = parentReal.endsWith(sep) ? parentReal : parentReal + sep;
  return childReal.startsWith(prefix);
}

/**
 * Validate that `p` is safe to treat as a trusted, privileged executable that
 * ccroute will spawn.
 *
 * This is the hardening for CVE-worthy bug: a project-scope `.commandcode/deal-router.yaml`
 * with `cmdPath: ./evil.sh` used to be accepted as long as the path existed
 * (`existsSync` was the *only* check). That let a project directory — untrusted
 * input — cause arbitrary code execution on read-only commands like `ccroute decide`.
 *
 * Checks, in order:
 *  - must be an absolute path (relative paths are rejected outright by the caller
 *    before this function is even reached)
 *  - must resolve via `realpathSync` (follows symlinks) to a path that actually exists
 *  - the resolved target must be a regular file (`statSync(...).isFile()`), not a
 *    directory, device, socket, etc.
 *  - the resolved target must be executable by the current user (`X_OK` via `accessSync`)
 *  - the resolved target must not live inside the current project directory (`process.cwd()`),
 *    directly or via a symlink that resolves there. A project-controlled file must never be
 *    treated as a trusted binary, no matter how it is referenced.
 */
function isSafeExecutable(p: string): boolean {
  if (!isAbsolute(p)) return false;
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return false;
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(real);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  try {
    accessSync(real, fsConstants.X_OK);
  } catch {
    return false;
  }
  let cwdReal: string;
  try {
    cwdReal = realpathSync(process.cwd());
  } catch {
    cwdReal = process.cwd();
  }
  if (isPathInside(real, cwdReal)) return false;
  return true;
}

export function resolveCmdPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Prefer a bare PATH lookup over any caller-supplied path: this is the resolution
  // the OS/shell itself trusts (governed by the user's own PATH, not by a config file
  // that may have come from an untrusted project directory), and it cannot be steered
  // by a project-scope `cmdPath` value.
  const which = spawnSync("command", ["-v", "cmd"], { encoding: "utf8", shell: false, env });
  const fromPath = which.stdout?.trim();
  if (which.status === 0 && fromPath) return fromPath;

  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error(
        `cmdPath must be an absolute path to an executable; rejected relative path: ${explicit}`,
      );
    }
    if (!isSafeExecutable(explicit)) {
      throw new Error(
        `cmdPath rejected: must be a regular file, executable by the current user, and must not resolve inside the current project directory: ${explicit}`,
      );
    }
    return explicit;
  }

  if (
    env.CCROUTE_CMD_PATH &&
    isAbsolute(env.CCROUTE_CMD_PATH) &&
    isSafeExecutable(env.CCROUTE_CMD_PATH)
  ) {
    return env.CCROUTE_CMD_PATH;
  }

  // fallback: try PATH via spawn of cmd itself
  const probe = spawnSync("cmd", ["--version"], { encoding: "utf8", shell: false, env });
  if (probe.status === 0) return "cmd";
  return null;
}

export function runCmdCapture(
  cmdPath: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmdPath, args, {
    encoding: "utf8",
    shell: false,
    timeout: opts?.timeoutMs ?? 30_000,
    env: opts?.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function probeCommandCode(cmdPath?: string): CmdProbe {
  const path = resolveCmdPath(cmdPath);
  if (!path) {
    return { path: null, version: null, helpSnippet: null, error: "cmd executable not found" };
  }
  const ver = runCmdCapture(path, ["--version"]);
  const help = runCmdCapture(path, ["--help"]);
  const helpText = help.stdout || help.stderr;
  return {
    path,
    version: ver.stdout.trim() || ver.stderr.trim() || null,
    // Keep enough of --help for flag detection (auto-accept etc. appear late)
    helpSnippet: helpText.slice(0, 20_000),
    error: ver.status === 0 ? undefined : `cmd --version exited ${ver.status}`,
  };
}

export interface CmdStatus {
  authenticated?: boolean;
  version?: string;
  user?: string;
  model?: string;
  context_window?: number;
  raw: unknown;
}

export function getCmdStatus(cmdPath: string): CmdStatus | null {
  const r = runCmdCapture(cmdPath, ["status", "--json"]);
  if (r.status !== 0) return null;
  try {
    const raw = JSON.parse(r.stdout.trim().split("\n").pop() || r.stdout);
    return { ...raw, raw };
  } catch {
    return null;
  }
}
