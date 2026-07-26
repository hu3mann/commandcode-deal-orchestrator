/**
 * Pure orchestration for a single typed prompt.
 * No model requests are made here — only decide + setModel side effects via callbacks.
 */

import { formatRouteWarning } from "./errors.js";
import { parseRouterMarkers, shouldAutoRoute } from "./markers.js";
import type { FailureCause, RouteClientResult, SessionRouteState } from "./types.js";
import { HARD_DECIDE_TIMEOUT_MS } from "./types.js";

export interface RoutePromptDeps {
  decide: (opts: {
    taskText: string;
    profile?: string | null;
    model?: string | null;
    timeoutMs?: number;
  }) => Promise<RouteClientResult>;
  setModel: (modelId: string) => void;
  setEffort?: (effort: string) => void;
  warn: (message: string) => void;
  onSuccess: (info: {
    modelId: string;
    decisionId: string;
    latencyMs: number;
    taskClass?: string;
    profile?: string;
    decision?: unknown;
  }) => void;
  onFailure: (cause: FailureCause, message: string, explicitOverride: boolean) => void;
  newDecisionId: () => string;
  timeoutMs?: number;
}

export type RoutePromptOutcome =
  | { kind: "pass_through"; text: string; routed: false }
  | { kind: "routed"; text: string; modelId: string; decisionId: string }
  | { kind: "handled"; message: string }
  | { kind: "failed_open"; text: string; cause: FailureCause };

/**
 * Route a typed prompt. Returns the text to forward (markers stripped) and side effects
 * applied via deps. Never initiates orchestration or repository writes.
 */
export async function routeTypedPrompt(
  text: string,
  state: SessionRouteState,
  deps: RoutePromptDeps,
): Promise<RoutePromptOutcome> {
  const markers = parseRouterMarkers(text);
  const forwardText = markers.cleaned.length > 0 ? markers.cleaned : text.trim();
  const explicitOverride = Boolean(markers.modelOverride);

  // !route-off disables automatic switching for this prompt (explicit model still allowed).
  if (markers.routeOff && !explicitOverride) {
    return { kind: "pass_through", text: forwardText, routed: false };
  }

  // Session-local routing off: only explicit intent routes (route-on, profile marker, model).
  // activeProfile alone must not force a switch while routing is disabled.
  const explicitIntent = markers.routeOn || explicitOverride || markers.profile !== null;
  if (!shouldAutoRoute(state.routingEnabled, markers) && !explicitIntent) {
    return { kind: "pass_through", text: forwardText, routed: false };
  }
  if (!state.routingEnabled && !explicitIntent) {
    return { kind: "pass_through", text: forwardText, routed: false };
  }

  const profile = markers.profile ?? state.activeProfile;

  const result = await deps.decide({
    taskText: markers.routingText || forwardText,
    profile,
    model: markers.modelOverride,
    timeoutMs: deps.timeoutMs ?? HARD_DECIDE_TIMEOUT_MS,
  });

  if (!result.ok || !result.modelId) {
    const cause = result.cause ?? "unknown";
    const message = result.errorMessage ?? "route failed";
    deps.onFailure(cause, message, explicitOverride);
    if (explicitOverride) {
      return {
        kind: "handled",
        message: formatRouteWarning("unavailable_override", message),
      };
    }
    deps.warn(formatRouteWarning(cause, message));
    return { kind: "failed_open", text: forwardText, cause };
  }

  try {
    deps.setModel(result.modelId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.onFailure("compatibility", msg, explicitOverride);
    if (explicitOverride) {
      return { kind: "handled", message: formatRouteWarning("unavailable_override", msg) };
    }
    deps.warn(formatRouteWarning("compatibility", msg));
    return { kind: "failed_open", text: forwardText, cause: "compatibility" };
  }

  if (result.effort && deps.setEffort) {
    try {
      deps.setEffort(result.effort);
    } catch {
      // Effort is best-effort; model selection already applied.
    }
  }

  const decisionId = deps.newDecisionId();
  const decision =
    result.decision && typeof result.decision === "object"
      ? (result.decision as Record<string, unknown>)
      : {};
  deps.onSuccess({
    modelId: result.modelId,
    decisionId,
    latencyMs: result.latencyMs,
    taskClass: typeof decision.taskClass === "string" ? decision.taskClass : undefined,
    profile: typeof decision.profile === "string" ? decision.profile : (profile ?? undefined),
    decision: result.decision,
  });

  return {
    kind: "routed",
    text: forwardText,
    modelId: result.modelId,
    decisionId,
  };
}
