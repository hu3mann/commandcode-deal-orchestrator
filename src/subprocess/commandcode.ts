import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { buildCmdArgv } from "../security/command-policy.js";
import { CHILD_ROLE_INSTRUCTION, childEnv } from "../security/recursion-guard.js";
import { buildChildProcessEnv } from "./environment.js";

export interface SpawnCmdOptions {
  cmdPath: string;
  model: string;
  stdinText: string;
  plan?: boolean;
  autoAccept?: boolean;
  unsafeYolo?: boolean;
  maxTurns?: number;
  trust?: boolean;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  role?: string;
  runId?: string;
  outputFormat?: "text" | "json";
}

export interface SpawnCmdResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  argv: string[];
  durationMs: number;
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* ignore */
  }
}

export async function spawnCommandCode(opts: SpawnCmdOptions): Promise<SpawnCmdResult> {
  const argv = buildCmdArgv({
    model: opts.model,
    print: true,
    plan: opts.plan,
    autoAccept: opts.autoAccept,
    unsafeYolo: opts.unsafeYolo,
    maxTurns: opts.maxTurns,
    trust: opts.trust,
    outputFormat: opts.outputFormat,
  });

  const maxOut = opts.maxStdoutBytes ?? 2_000_000;
  const maxErr = opts.maxStderrBytes ?? 500_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  let stdin = opts.stdinText;
  if (opts.role) {
    stdin = `${CHILD_ROLE_INSTRUCTION}\n\n${stdin}`;
  }

  const extraEnv = opts.role && opts.runId ? childEnv(opts.role, opts.runId, 0) : {};
  const env = buildChildProcessEnv(opts.env ?? process.env, extraEnv);

  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(opts.cmdPath, argv, {
      shell: false,
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => {
        try {
          if (child.pid) process.kill(child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000);
    }, timeoutMs);

    child.stdout.on("data", (buf: Buffer) => {
      if (stdout.length < maxOut) {
        stdout += buf.toString("utf8");
        if (stdout.length > maxOut) stdout = stdout.slice(0, maxOut);
      }
    });
    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length < maxErr) {
        stderr += buf.toString("utf8");
        if (stderr.length > maxErr) stderr = stderr.slice(0, maxErr);
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        signal: null,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
        argv: [opts.cmdPath, ...argv],
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        timedOut,
        argv: [opts.cmdPath, ...argv],
        durationMs: Date.now() - started,
      });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Test helper: count whether argv would include auto-accept */
export function wouldAutoAccept(apply: boolean): boolean {
  return apply === true;
}
