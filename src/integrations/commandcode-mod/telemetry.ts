import { randomUUID } from "node:crypto";
import type { TelemetryEvent } from "../../domain/telemetry.js";
import { appendTelemetry } from "../../telemetry/store.js";
import type { FailureCause, ValueLabel } from "./types.js";

export interface ModTelemetryPaths {
  path: string;
  enabled: boolean;
}

export interface UsageObservation {
  provider?: string;
  modelId?: string;
  effort?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  requestStatus?: string;
  sessionId?: string;
  routeDecisionId?: string | null;
  labels?: Partial<Record<string, ValueLabel>>;
}

function label(value: unknown, explicit?: ValueLabel): ValueLabel {
  if (explicit) return explicit;
  if (value === undefined || value === null) return "UNKNOWN";
  return "OBSERVED";
}

export function buildUsageEvent(runId: string, usage: UsageObservation): TelemetryEvent {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    runId,
    event: "mod.model_usage",
    modelId: usage.modelId,
    success: usage.requestStatus ? usage.requestStatus !== "error" : undefined,
    latencyMs: usage.latencyMs,
    meta: {
      source: "commandcode-mod",
      provider: usage.provider,
      effort: usage.effort,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      requestStatus: usage.requestStatus,
      sessionId: usage.sessionId,
      routeDecisionId: usage.routeDecisionId ?? undefined,
      labels: {
        inputTokens: label(usage.inputTokens, usage.labels?.inputTokens),
        cachedInputTokens: label(usage.cachedInputTokens, usage.labels?.cachedInputTokens),
        outputTokens: label(usage.outputTokens, usage.labels?.outputTokens),
        latencyMs: label(usage.latencyMs, usage.labels?.latencyMs),
        modelId: label(usage.modelId, usage.labels?.modelId),
      },
      // Never store full prompts
      promptStored: false,
    },
  };
}

export function buildRouteDecisionEvent(
  runId: string,
  decisionId: string,
  modelId: string,
  meta: Record<string, unknown>,
): TelemetryEvent {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    runId,
    event: "mod.route_decision",
    modelId,
    success: true,
    latencyMs: typeof meta.latencyMs === "number" ? meta.latencyMs : undefined,
    meta: {
      source: "commandcode-mod",
      routeDecisionId: decisionId,
      ...meta,
      promptStored: false,
    },
  };
}

export function buildRouteFailureEvent(
  runId: string,
  cause: FailureCause,
  message: string,
  meta: Record<string, unknown> = {},
): TelemetryEvent {
  return {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    runId,
    event: "mod.route_failure",
    success: false,
    errorCode: cause,
    meta: {
      source: "commandcode-mod",
      cause,
      message,
      ...meta,
      promptStored: false,
    },
  };
}

export function recordEvent(paths: ModTelemetryPaths, event: TelemetryEvent): void {
  if (!paths.enabled) return;
  try {
    appendTelemetry(paths.path, event);
  } catch {
    /* telemetry must never break routing */
  }
}

export function newDecisionId(): string {
  return randomUUID();
}

export function newRunId(prefix = "mod"): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Extract usage fields from a model_request_end event payload without inventing tokens.
 */
export function extractUsageFromEvent(event: Record<string, unknown>): UsageObservation {
  const usage =
    event.usage && typeof event.usage === "object" ? (event.usage as Record<string, unknown>) : {};
  const inputTokens =
    typeof usage.inputTokens === "number"
      ? usage.inputTokens
      : typeof usage.promptTokens === "number"
        ? usage.promptTokens
        : undefined;
  const outputTokens =
    typeof usage.outputTokens === "number"
      ? usage.outputTokens
      : typeof usage.completionTokens === "number"
        ? usage.completionTokens
        : undefined;
  const cachedInputTokens =
    typeof usage.cachedInputTokens === "number"
      ? usage.cachedInputTokens
      : typeof usage.cacheReadTokens === "number"
        ? usage.cacheReadTokens
        : undefined;

  return {
    modelId: typeof event.model === "string" ? event.model : undefined,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    requestStatus:
      typeof event.stopReason === "string"
        ? event.stopReason
        : typeof event.status === "string"
          ? event.status
          : undefined,
    sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
    labels: {
      inputTokens: inputTokens === undefined ? "UNKNOWN" : "OBSERVED",
      outputTokens: outputTokens === undefined ? "UNKNOWN" : "OBSERVED",
      cachedInputTokens: cachedInputTokens === undefined ? "UNKNOWN" : "OBSERVED",
      modelId: typeof event.model === "string" ? "OBSERVED" : "UNKNOWN",
    },
  };
}
