import { type ChildProcess, spawn } from "node:child_process";

/**
 * §24.5 deterministic validation gate. This is the mechanism that stops the Reviewer LLM
 * from being the sole judge of success: it runs locally configured commands (type-check,
 * lint, unit tests, build, ...) as real child processes — never a shell string, always an
 * argv array with `shell: false` — and produces a structured, bounded result that the
 * orchestrator treats as authoritative regardless of what the Reviewer decides.
 */

export interface ValidationCommandSpec {
  /** Human-readable label, e.g. "typecheck". Also used as the artifact key. */
  name: string;
  /** argv[0] is the executable; the rest are literal arguments. Never shell-interpolated. */
  argv: string[];
  /** Per-command timeout override; falls back to the gate's default timeoutMs. */
  timeoutMs?: number;
}

export interface ValidationGateConfig {
  enabled: boolean;
  commands: ValidationCommandSpec[];
  /** Default per-command timeout, used when a command does not specify its own. */
  timeoutMs: number;
  /** Bounded output captured per command (combined stdout+stderr), in bytes. */
  maxOutputBytesPerCommand: number;
}

export interface ValidationCommandResult {
  name: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Combined stdout+stderr, bounded to maxOutputBytesPerCommand. */
  output: string;
  passed: boolean;
}

export interface ValidationGateResult {
  /** False when the gate was skipped entirely (explicit flag, disabled config, or no
   * commands configured) — in that case `passed` is true by construction, meaning "did not
   * block", not "verified good". Callers must check `ran` before trusting `passed` as a
   * quality signal. */
  ran: boolean;
  passed: boolean;
  results: ValidationCommandResult[];
  reason?: string;
}

/** Sensible defaults: the four gates named explicitly in §24.5 (type-check, lint, unit
 * tests, build), expressed as the project's own npm scripts so they stay correct if the
 * underlying tool invocation ever changes. */
export const DEFAULT_VALIDATION_COMMANDS: ValidationCommandSpec[] = [
  { name: "typecheck", argv: ["npm", "run", "typecheck"] },
  { name: "lint", argv: ["npm", "run", "lint"] },
  { name: "test", argv: ["npm", "test"] },
  { name: "build", argv: ["npm", "run", "build"] },
];

export const DEFAULT_VALIDATION_GATE_CONFIG: ValidationGateConfig = {
  enabled: true,
  commands: DEFAULT_VALIDATION_COMMANDS,
  timeoutMs: 300_000,
  maxOutputBytesPerCommand: 200_000,
};

type SpawnFn = typeof spawn;

function killTree(child: ChildProcess): void {
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

function runOne(
  spec: ValidationCommandSpec,
  cwd: string | undefined,
  defaultTimeoutMs: number,
  maxOutputBytes: number,
  spawnImpl: SpawnFn,
): Promise<ValidationCommandResult> {
  const [cmd, ...args] = spec.argv;
  const started = Date.now();
  if (!cmd) {
    return Promise.resolve({
      name: spec.name,
      argv: spec.argv,
      exitCode: 1,
      timedOut: false,
      durationMs: 0,
      output: "invalid command spec: empty argv",
      passed: false,
    });
  }

  return new Promise((resolve) => {
    const child: ChildProcess = spawnImpl(cmd, args, {
      shell: false,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let output = "";
    let timedOut = false;
    let settled = false;

    const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;
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

    const onData = (buf: Buffer) => {
      if (output.length < maxOutputBytes) {
        output += buf.toString("utf8");
        if (output.length > maxOutputBytes) {
          output = `${output.slice(0, maxOutputBytes)}\n...[output truncated]`;
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: spec.name,
        argv: spec.argv,
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - started,
        output: `${output}\n${err.message}`,
        passed: false,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name: spec.name,
        argv: spec.argv,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        output,
        passed: !timedOut && code === 0,
      });
    });
  });
}

export interface RunValidationGateOptions {
  /** Partial override merged over DEFAULT_VALIDATION_GATE_CONFIG. */
  config?: Partial<ValidationGateConfig>;
  /** Skip the gate entirely — must be an explicit, deliberate opt-out. Defaults to false
   * (gate runs) so validation is on by default per §24.5. */
  skip?: boolean;
  cwd?: string;
  /** Injection seam for tests: never spawn real processes from a unit test. */
  spawnImpl?: SpawnFn;
}

export async function runValidationGate(
  opts: RunValidationGateOptions,
): Promise<ValidationGateResult> {
  if (opts.skip) {
    return { ran: false, passed: true, results: [], reason: "skipped by explicit flag" };
  }
  const cfg: ValidationGateConfig = {
    ...DEFAULT_VALIDATION_GATE_CONFIG,
    ...opts.config,
    commands: opts.config?.commands ?? DEFAULT_VALIDATION_GATE_CONFIG.commands,
  };
  if (!cfg.enabled) {
    return { ran: false, passed: true, results: [], reason: "disabled by configuration" };
  }
  if (cfg.commands.length === 0) {
    return { ran: false, passed: true, results: [], reason: "no validation commands configured" };
  }

  const spawnImpl = opts.spawnImpl ?? spawn;
  const results: ValidationCommandResult[] = [];
  for (const spec of cfg.commands) {
    // Run every configured command (do not short-circuit on first failure) so the
    // Reviewer — and the run's persisted artifacts — see the complete picture, matching
    // §24.6's requirement that the Reviewer receive real test results.
    const result = await runOne(
      spec,
      opts.cwd,
      cfg.timeoutMs,
      cfg.maxOutputBytesPerCommand,
      spawnImpl,
    );
    results.push(result);
  }
  const passed = results.every((r) => r.passed);
  return { ran: true, passed, results };
}

export function formatValidationSummary(result: ValidationGateResult): string {
  if (!result.ran) {
    return `Deterministic validation gate skipped (${result.reason ?? "unknown reason"}).`;
  }
  const lines = result.results.map((r) => {
    const status = r.passed ? "PASS" : "FAIL";
    const timeout = r.timedOut ? " [TIMED OUT]" : "";
    return `- ${r.name}: ${status} (exit=${r.exitCode ?? "null"}, ${r.durationMs}ms)${timeout}\n  argv: ${r.argv.join(" ")}\n  output: ${r.output.slice(0, 4000)}`;
  });
  return `Deterministic validation gate ${result.passed ? "PASSED" : "FAILED"}:\n${lines.join("\n")}`;
}
