/**
 * Minimal ModApi surface used by the ccroute Mod.
 * Mirrors CommandCode @commandcode/harness ModApi for the callbacks we depend on.
 * We do not import private CommandCode packages.
 */

export type TransformInputResult =
  | { action: "continue" }
  | { action: "transform"; text: string }
  | { action: "handled"; message?: string }
  | undefined;

export type BeforeToolCallResult =
  | {
      block?: boolean;
      additionalContext?: string;
      input?: Record<string, unknown>;
      terminate?: boolean;
    }
  | undefined;

export interface ModHooks {
  transformInput?: (args: { text: string }) => TransformInputResult | Promise<TransformInputResult>;
  beforeToolCall?: (args: {
    toolCallId?: string;
    toolName: string;
    input: Record<string, unknown>;
    state?: unknown;
  }) => BeforeToolCallResult | Promise<BeforeToolCallResult>;
  onSessionStart?: (args: { source: string }) => void | Promise<void>;
  onSessionEnd?: (args: { reason: string }) => void | Promise<void>;
}

export interface ModCommandHandlerArgs {
  args: string;
  ui?: {
    notify?: (message: string, level?: string) => void;
  };
  cwd?: string;
  exec?: (opts: {
    command: string;
    args?: string[];
  }) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export interface ModCommandResult {
  message?: string;
  prompt?: string;
}

export interface ModApi {
  name: string;
  cwd: string;
  hooks: (hooks: ModHooks) => { dispose(): void };
  addCommand: (command: {
    name: string;
    description?: string;
    argumentHint?: string;
    handler: (args: ModCommandHandlerArgs) => ModCommandResult | Promise<ModCommandResult>;
  }) => { dispose(): void };
  on: (event: string, handler: (event: Record<string, unknown>) => void) => { dispose(): void };
  setModel: (modelId: string) => void;
  setEffort: (effort: string) => void;
  ui: {
    notify: (message: string, level?: string) => void;
  };
  showEntry?: (customType: string, data?: unknown) => void;
  exec?: (opts: {
    command: string;
    args?: string[];
  }) => Promise<{ stdout: string; stderr: string; code: number }>;
}

export type CompatibilityStatus =
  | "SUPPORTED"
  | "DEGRADED"
  | "UNSUPPORTED"
  | "MISSING_CALLBACK"
  | "UNKNOWN";

export type FailureCause =
  | "timeout"
  | "inventory"
  | "pricing"
  | "compatibility"
  | "malformed_json"
  | "unavailable_override"
  | "no_eligible_route"
  | "spawn"
  | "unknown";

export type ValueLabel = "OBSERVED" | "ESTIMATED" | "UNKNOWN";

export interface CompatibilityReport {
  status: CompatibilityStatus;
  commandCodeVersion: string | null;
  modApiVersion: string;
  missing: string[];
  present: string[];
  notes: string[];
}

export interface RouteClientResult {
  ok: boolean;
  modelId?: string;
  effort?: string;
  decision?: unknown;
  task?: unknown;
  raw?: string;
  latencyMs: number;
  cause?: FailureCause;
  errorMessage?: string;
}

export interface SessionRouteState {
  routingEnabled: boolean;
  activeProfile: "cheapest" | "balanced" | "frontier" | null;
  lastDecision: {
    modelId: string;
    taskClass?: string;
    profile?: string;
    at: string;
    decisionId: string;
    latencyMs: number;
  } | null;
  lastFailure: {
    cause: FailureCause;
    message: string;
    at: string;
  } | null;
  lastRouteDecisionId: string | null;
  classifierModelRequests: number;
  routeDecisions: number;
  modelRequests: number;
}

export const MOD_VERSION = "0.1.0";
export const MOD_API_VERSION = "ModApi@command-code-1.4.1";
export const COMPAT_MIN_COMMANDCODE = "1.4.0";
export const PREFERRED_DECIDE_TIMEOUT_MS = 500;
export const HARD_DECIDE_TIMEOUT_MS = 1500;
