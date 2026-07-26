import type { FailureCause, SessionRouteState } from "./types.js";

export function createSessionState(): SessionRouteState {
  return {
    routingEnabled: true,
    activeProfile: null,
    lastDecision: null,
    lastFailure: null,
    lastRouteDecisionId: null,
    classifierModelRequests: 0,
    routeDecisions: 0,
    modelRequests: 0,
  };
}

export function recordSuccess(
  state: SessionRouteState,
  input: {
    modelId: string;
    taskClass?: string;
    profile?: string;
    decisionId: string;
    latencyMs: number;
  },
): SessionRouteState {
  return {
    ...state,
    routeDecisions: state.routeDecisions + 1,
    lastRouteDecisionId: input.decisionId,
    lastDecision: {
      modelId: input.modelId,
      taskClass: input.taskClass,
      profile: input.profile,
      at: new Date().toISOString(),
      decisionId: input.decisionId,
      latencyMs: input.latencyMs,
    },
    lastFailure: null,
  };
}

export function recordFailure(
  state: SessionRouteState,
  cause: FailureCause,
  message: string,
): SessionRouteState {
  return {
    ...state,
    lastFailure: {
      cause,
      message,
      at: new Date().toISOString(),
    },
  };
}
