import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type FailureCause, HARD_DECIDE_TIMEOUT_MS, type RouteClientResult } from "./types.js";

/** Subset of decide --json output we require. */
export const DecideJsonSchema = z.object({
  decision: z.object({
    schemaVersion: z.literal(1),
    selectedModelId: z.string().min(1),
    taskClass: z.string().optional(),
    profile: z.string().optional(),
    qualityFloor: z.string().optional(),
    candidates: z.array(z.unknown()).optional(),
    rejected: z.array(z.unknown()).optional(),
    pricingSnapshotAgeMs: z.number().optional(),
    pricingSnapshotRetrievedAt: z.string().optional(),
    explanation: z.string().optional(),
    overridesApplied: z.array(z.string()).optional(),
    dealAffectedSelection: z.boolean().optional(),
    tieBreakRule: z.string().optional(),
  }),
  task: z.unknown().optional(),
});

export type DecideJson = z.infer<typeof DecideJsonSchema>;

export interface DecideOptions {
  taskText: string;
  profile?: string | null;
  model?: string | null;
  timeoutMs?: number;
  /** Override binary resolution (tests). */
  ccrouteCommand?: { command: string; prefixArgs?: string[] };
  env?: NodeJS.ProcessEnv;
  /** Injected live model set for post-validation (optional). */
  liveModelIds?: ReadonlySet<string> | null;
}

function packageCliPath(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/integrations/commandcode-mod → repo root dist/cli.js
    const candidates = [join(here, "../../../dist/cli.js"), join(here, "../../../../dist/cli.js")];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function resolveCcrouteInvocation(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  prefixArgs: string[];
} {
  if (env.CCROUTE_BIN?.trim()) {
    return { command: env.CCROUTE_BIN.trim(), prefixArgs: [] };
  }
  const cli = packageCliPath();
  if (cli) {
    return { command: process.execPath, prefixArgs: [cli] };
  }
  return { command: "ccroute", prefixArgs: [] };
}

function classifyError(message: string, code?: string): FailureCause {
  const m = message.toLowerCase();
  if (code === "TIMEOUT" || m.includes("timed out") || m.includes("timeout")) return "timeout";
  if (m.includes("no eligible") || m.includes("no_eligible") || code === "NO_ELIGIBLE_ROUTE")
    return "no_eligible_route";
  if (m.includes("unknown model") || m.includes("not in live") || m.includes("inventory"))
    return "inventory";
  if (m.includes("pricing") || m.includes("expired") || m.includes("deal")) return "pricing";
  if (m.includes("override") || m.includes("explicit model")) return "unavailable_override";
  if (m.includes("enoent") || m.includes("spawn") || m.includes("not found")) return "spawn";
  if (m.includes("json") || m.includes("malformed")) return "malformed_json";
  return "unknown";
}

export function validateDecidePayload(
  raw: string,
  liveModelIds?: ReadonlySet<string> | null,
): { ok: true; data: DecideJson } | { ok: false; cause: FailureCause; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, cause: "malformed_json", message: "decide output is not JSON" };
  }
  const result = DecideJsonSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      cause: "malformed_json",
      message: `decide JSON failed schema validation: ${result.error.message}`,
    };
  }
  const modelId = result.data.decision.selectedModelId;
  if (liveModelIds && liveModelIds.size > 0 && !liveModelIds.has(modelId)) {
    return {
      ok: false,
      cause: "inventory",
      message: `selected model ${modelId} not in live catalog`,
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Deterministic route selection via `ccroute decide --json`.
 * Never spawns a model. Never writes the repository.
 */
export async function decideRoute(opts: DecideOptions): Promise<RouteClientResult> {
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? HARD_DECIDE_TIMEOUT_MS, 1),
    HARD_DECIDE_TIMEOUT_MS,
  );
  const inv = opts.ccrouteCommand
    ? {
        command: opts.ccrouteCommand.command,
        prefixArgs: opts.ccrouteCommand.prefixArgs ?? [],
      }
    : resolveCcrouteInvocation(opts.env ?? process.env);

  const args = [
    ...inv.prefixArgs,
    "decide",
    "--json",
    ...(opts.profile ? ["--profile", opts.profile] : []),
    ...(opts.model ? ["--model", opts.model] : []),
    opts.taskText,
  ];

  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(inv.command, args, {
      shell: false,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        ok: false,
        latencyMs: Date.now() - started,
        cause: "timeout",
        errorMessage: `ccroute decide exceeded ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        latencyMs: Date.now() - started,
        cause: "spawn",
        errorMessage: err.message,
        raw: stderr,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      if (code !== 0) {
        const msg = (stderr || stdout || `exit ${code}`).trim();
        resolve({
          ok: false,
          latencyMs,
          cause: classifyError(msg),
          errorMessage: msg,
          raw: stdout || stderr,
        });
        return;
      }
      const validated = validateDecidePayload(stdout, opts.liveModelIds);
      if (!validated.ok) {
        resolve({
          ok: false,
          latencyMs,
          cause: validated.cause,
          errorMessage: validated.message,
          raw: stdout,
        });
        return;
      }
      resolve({
        ok: true,
        modelId: validated.data.decision.selectedModelId,
        decision: validated.data.decision,
        task: validated.data.task,
        raw: stdout,
        latencyMs,
      });
    });
  });
}
