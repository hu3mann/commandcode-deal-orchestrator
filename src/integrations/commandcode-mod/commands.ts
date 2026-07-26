import { decideRoute } from "./router-client.js";
import type { CompatibilityReport, SessionRouteState } from "./types.js";
import { MOD_API_VERSION, MOD_VERSION } from "./types.js";
import type { RouteClientResult } from "./types.js";

export function formatStatus(opts: {
  state: SessionRouteState;
  compatibility: CompatibilityReport;
  pricingAgeMs?: number | null;
  catalogAgeMs?: number | null;
}): string {
  const { state, compatibility } = opts;
  const lines = [
    `ccroute Mod ${MOD_VERSION}`,
    `modApi: ${MOD_API_VERSION}`,
    `compatibility: ${compatibility.status}`,
    `commandCode: ${compatibility.commandCodeVersion ?? "unknown"}`,
    `routing: ${state.routingEnabled ? "enabled" : "disabled"} (session-local)`,
    `activeProfile: ${state.activeProfile ?? "(default)"}`,
    `pricingFreshnessMs: ${opts.pricingAgeMs ?? "unknown"}`,
    `catalogFreshnessMs: ${opts.catalogAgeMs ?? "unknown"}`,
    `lastRoute: ${
      state.lastDecision
        ? `${state.lastDecision.modelId} @ ${state.lastDecision.at} (${state.lastDecision.decisionId})`
        : "(none)"
    }`,
    `lastFailure: ${
      state.lastFailure ? `${state.lastFailure.cause}: ${state.lastFailure.message}` : "(none)"
    }`,
  ];
  return lines.join("\n");
}

export function formatExplain(result: RouteClientResult): string {
  if (!result.ok || !result.decision || typeof result.decision !== "object") {
    return `route failed: ${result.cause ?? "unknown"} — ${result.errorMessage ?? ""}`.trim();
  }
  const d = result.decision as Record<string, unknown>;
  const rejected = Array.isArray(d.rejected) ? d.rejected : [];
  const candidates = Array.isArray(d.candidates) ? d.candidates : [];
  return [
    `selected: ${result.modelId}`,
    `taskClass: ${d.taskClass ?? "?"}`,
    `qualityFloor: ${d.qualityFloor ?? "?"}`,
    `profile: ${d.profile ?? "?"}`,
    `candidates: ${candidates.length}`,
    `rejections: ${rejected.length}`,
    `pricingAgeMs: ${d.pricingSnapshotAgeMs ?? "?"}`,
    `pricingRetrievedAt: ${d.pricingSnapshotRetrievedAt ?? "?"}`,
    "estimateStatus: estimate",
    `explanation: ${d.explanation ?? ""}`,
  ].join("\n");
}

export async function runRouteCommand(opts: {
  taskText: string;
  profile?: string | null;
  model?: string | null;
  timeoutMs?: number;
  ccrouteCommand?: { command: string; prefixArgs?: string[] };
  /** Test / DI seam; defaults to subprocess decideRoute. */
  decide?: typeof decideRoute;
}): Promise<{ message: string; result: RouteClientResult }> {
  const decide = opts.decide ?? decideRoute;
  const result = await decide({
    taskText: opts.taskText,
    profile: opts.profile,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    ccrouteCommand: opts.ccrouteCommand,
  });
  if (!result.ok) {
    return {
      message: `route failed (${result.cause}): ${result.errorMessage ?? "unknown"}`,
      result,
    };
  }
  return {
    message: `selected model: ${result.modelId}\n(no repository writes; decide-only)`,
    result,
  };
}

const PROFILES = new Set(["cheapest", "balanced", "frontier"]);

export function parseProfileArg(args: string):
  | {
      ok: true;
      profile: "cheapest" | "balanced" | "frontier";
    }
  | { ok: false; message: string } {
  const p = args.trim().toLowerCase();
  if (!PROFILES.has(p)) {
    return {
      ok: false,
      message: `unknown profile "${args.trim()}"; allowed: cheapest | balanced | frontier`,
    };
  }
  return { ok: true, profile: p as "cheapest" | "balanced" | "frontier" };
}
