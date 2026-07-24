import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface CmdProbe {
  path: string | null;
  version: string | null;
  helpSnippet: string | null;
  error?: string;
}

export function resolveCmdPath(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (explicit && existsSync(explicit)) return explicit;
  if (env.CCROUTE_CMD_PATH && existsSync(env.CCROUTE_CMD_PATH)) return env.CCROUTE_CMD_PATH;
  const which = spawnSync("command", ["-v", "cmd"], { encoding: "utf8", shell: false });
  const p = which.stdout?.trim();
  if (which.status === 0 && p) return p;
  // fallback: try PATH via spawn of cmd itself
  const probe = spawnSync("cmd", ["--version"], { encoding: "utf8", shell: false });
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
