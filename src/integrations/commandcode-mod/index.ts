/**
 * CommandCode Mod — zero-friction deterministic routing for ordinary typed prompts.
 *
 * Hard boundaries:
 *   - May select a model (via setModel)
 *   - Must not enable --apply / auto-accept / YOLO / permission mode
 *   - Must not launch recursive ccroute orchestration
 *   - Must not invent model IDs (validate via ccroute decide)
 *   - Must not store full prompts by default
 *
 * Load: `cmd --mod ./src/integrations/commandcode-mod/index.ts`
 * or managed install: `ccroute install` / `ccroute install --user`
 * (wraps official `cmd mods add` with a manifest and optional skill/hooks).
 */

import { spawn } from "node:child_process";
import {
  oneLineRefreshStatus,
  planSessionStartRefresh,
  spawnNonblockingRefresh,
} from "../../refresh/session-start.js";
import { formatExplain, formatStatus, parseProfileArg, runRouteCommand } from "./commands.js";
import {
  canRouteAutomatically,
  inspectModApi,
  qualifyCommandCodeVersion,
} from "./compatibility.js";
import { shouldBlockChildCcroute } from "./recursion.js";
import { routeTypedPrompt } from "./route-prompt.js";
import { decideRoute, resolveCcrouteInvocation } from "./router-client.js";
import { createSessionState, recordFailure, recordSuccess } from "./session-state.js";
import {
  buildRouteDecisionEvent,
  buildRouteFailureEvent,
  buildUsageEvent,
  extractUsageFromEvent,
  newDecisionId,
  newRunId,
  recordEvent,
} from "./telemetry.js";
import type { CompatibilityReport, ModApi, SessionRouteState } from "./types.js";
import { HARD_DECIDE_TIMEOUT_MS, MOD_API_VERSION, MOD_VERSION } from "./types.js";

export {
  parseRouterMarkers,
  shouldAutoRoute,
} from "./markers.js";
export {
  inspectModApi,
  qualifyCommandCodeVersion,
  canRouteAutomatically,
} from "./compatibility.js";
export { decideRoute, validateDecidePayload, resolveCcrouteInvocation } from "./router-client.js";
export { routeTypedPrompt } from "./route-prompt.js";
export {
  shouldBlockChildCcroute,
  parseCommandLine,
  isCcrouteInvocation,
} from "./recursion.js";
export { createSessionState, recordSuccess, recordFailure } from "./session-state.js";
export {
  buildUsageEvent,
  buildRouteDecisionEvent,
  buildRouteFailureEvent,
  extractUsageFromEvent,
} from "./telemetry.js";
export type * from "./types.js";

export interface CreateModOptions {
  commandCodeVersion?: string | null;
  telemetryPath?: string;
  telemetryEnabled?: boolean;
  decideTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject decide implementation */
  decide?: typeof decideRoute;
}

function defaultTelemetryPath(): string {
  return "~/.commandcode/deal-router/telemetry.jsonl";
}

export function createCcrouteMod(options: CreateModOptions = {}) {
  return function ccrouteModFactory(cmd: ModApi): void {
    const env = options.env ?? process.env;
    let state: SessionRouteState = createSessionState();
    let compatibility: CompatibilityReport = inspectModApi(cmd);
    compatibility = qualifyCommandCodeVersion(options.commandCodeVersion ?? null, compatibility);
    const sessionRunId = newRunId("mod-session");
    const telemetry = {
      path: options.telemetryPath ?? defaultTelemetryPath(),
      enabled: options.telemetryEnabled !== false,
    };
    const timeoutMs = options.decideTimeoutMs ?? HARD_DECIDE_TIMEOUT_MS;
    const decide = options.decide ?? decideRoute;
    let routingLive = canRouteAutomatically(compatibility);

    if (!routingLive) {
      try {
        cmd.ui.notify(
          `ccroute Mod ${MOD_VERSION}: compatibility ${compatibility.status}; automatic routing disabled. Use CLI fallback.`,
          "warning",
        );
      } catch {
        /* headless */
      }
    }

    const applyRouteSideEffects = {
      onSuccess: (info: {
        modelId: string;
        decisionId: string;
        latencyMs: number;
        taskClass?: string;
        profile?: string;
        decision?: unknown;
      }) => {
        state = recordSuccess(state, info);
        recordEvent(
          telemetry,
          buildRouteDecisionEvent(sessionRunId, info.decisionId, info.modelId, {
            latencyMs: info.latencyMs,
            taskClass: info.taskClass,
            profile: info.profile,
            decision: info.decision,
          }),
        );
      },
      onFailure: (cause: Parameters<typeof recordFailure>[1], message: string) => {
        state = recordFailure(state, cause, message);
        recordEvent(telemetry, buildRouteFailureEvent(sessionRunId, cause, message));
      },
    };

    // ── Typed prompt routing (primary path) ───────────────────────────────
    if (typeof cmd.hooks === "function") {
      cmd.hooks({
        onSessionStart: () => {
          // Re-check API each session bind; version may be supplied later by host.
          compatibility = qualifyCommandCodeVersion(
            options.commandCodeVersion ?? compatibility.commandCodeVersion,
            inspectModApi(cmd),
          );
          routingLive = canRouteAutomatically(compatibility);

          // Non-blocking refresh: never wait, never model-call, never hard-fail session.
          // SessionStart has no prompt — static facts only; typed-input remains the router.
          try {
            const plan = planSessionStartRefresh({ routingEnabled: routingLive });
            if (plan.shouldAttempt) {
              try {
                const inv = resolveCcrouteInvocation(env);
                if (inv.command === "node" && inv.prefixArgs[0]) {
                  const child = spawn(
                    process.execPath,
                    [inv.prefixArgs[0], "refresh", "run", "--session-start"],
                    { detached: true, stdio: "ignore", env, shell: false },
                  );
                  child.unref();
                } else {
                  spawnNonblockingRefresh({
                    ccroutePath: inv.command === "ccroute" ? "ccroute" : inv.command,
                    env,
                  });
                }
              } catch {
                /* nonblocking: ignore */
              }
            }
            try {
              const line = oneLineRefreshStatus();
              if (line.includes("last error")) {
                cmd.ui.notify(line, "warning");
              }
            } catch {
              /* headless */
            }
          } catch {
            /* session must not fail */
          }
        },

        transformInput: async ({ text }) => {
          if (!routingLive) {
            return { action: "continue" };
          }

          // One-request property bookkeeping (no classifier LLM exists).
          const outcome = await routeTypedPrompt(text, state, {
            decide: (opts) =>
              decide({
                taskText: opts.taskText,
                profile: opts.profile,
                model: opts.model,
                timeoutMs: opts.timeoutMs ?? timeoutMs,
                env,
              }),
            setModel: (id) => {
              cmd.setModel(id);
            },
            setEffort:
              typeof cmd.setEffort === "function"
                ? (effort) => {
                    cmd.setEffort(effort);
                  }
                : undefined,
            warn: (message) => {
              try {
                cmd.ui.notify(message, "warning");
              } catch {
                /* ignore */
              }
            },
            onSuccess: applyRouteSideEffects.onSuccess,
            onFailure: (cause, message, _explicit) => {
              applyRouteSideEffects.onFailure(cause, message);
            },
            newDecisionId,
            timeoutMs,
          });

          if (outcome.kind === "handled") {
            return { action: "handled", message: outcome.message };
          }
          if (outcome.kind === "routed" || outcome.kind === "failed_open") {
            // Strip removable markers; never rewrite task intent beyond markers.
            if (outcome.text !== text) {
              return { action: "transform", text: outcome.text };
            }
            return { action: "continue" };
          }
          if (outcome.kind === "pass_through" && outcome.text !== text) {
            return { action: "transform", text: outcome.text };
          }
          return { action: "continue" };
        },

        beforeToolCall: ({ toolName, input }) => {
          const decision = shouldBlockChildCcroute(env, {
            toolName,
            input: input ?? {},
          });
          if (decision.block) {
            return {
              block: true,
              additionalContext: decision.reason,
            };
          }
          return undefined;
        },
      });
    }

    // ── Usage telemetry (observe-only) ────────────────────────────────────
    if (typeof cmd.on === "function") {
      cmd.on("model_request_start", () => {
        state = { ...state, modelRequests: state.modelRequests + 1 };
      });
      cmd.on("model_request_end", (event) => {
        const usage = extractUsageFromEvent(event);
        usage.routeDecisionId = state.lastRouteDecisionId;
        recordEvent(telemetry, buildUsageEvent(sessionRunId, usage));
      });
    }

    // ── Explicit commands ─────────────────────────────────────────────────
    if (typeof cmd.addCommand === "function") {
      cmd.addCommand({
        name: "route",
        description: "Deterministic ccroute decide for task text (no writes)",
        argumentHint: "<task text>",
        handler: async ({ args }) => {
          const taskText = (args ?? "").trim();
          if (!taskText) {
            return { message: "usage: /route <task text>" };
          }
          const { message } = await runRouteCommand({
            taskText,
            profile: state.activeProfile,
            timeoutMs,
            decide,
          });
          return { message };
        },
      });

      cmd.addCommand({
        name: "route-explain",
        description: "Explain deterministic route selection for task text",
        argumentHint: "<task text>",
        handler: async ({ args }) => {
          const taskText = (args ?? "").trim();
          if (!taskText) {
            return { message: "usage: /route-explain <task text>" };
          }
          const result = await decide({
            taskText,
            profile: state.activeProfile,
            timeoutMs,
            env,
          });
          return { message: formatExplain(result) };
        },
      });

      cmd.addCommand({
        name: "router-status",
        description: "Show ccroute Mod routing status",
        handler: () => ({
          message: formatStatus({
            state,
            compatibility,
          }),
        }),
      });

      cmd.addCommand({
        name: "router-profile",
        description: "Set session-local routing profile (cheapest|balanced|frontier)",
        argumentHint: "cheapest|balanced|frontier",
        handler: ({ args }) => {
          const parsed = parseProfileArg(args ?? "");
          if (!parsed.ok) return { message: parsed.message };
          state = { ...state, activeProfile: parsed.profile };
          return {
            message: `session profile set to ${parsed.profile} (session-local; not written to global settings)`,
          };
        },
      });

      cmd.addCommand({
        name: "router-on",
        description: "Enable automatic typed-prompt routing (session-local)",
        handler: () => {
          state = { ...state, routingEnabled: true };
          return { message: "automatic routing enabled for this session" };
        },
      });

      cmd.addCommand({
        name: "router-off",
        description: "Disable automatic typed-prompt routing (session-local)",
        handler: () => {
          state = { ...state, routingEnabled: false };
          return { message: "automatic routing disabled for this session" };
        },
      });
    }

    // Surface version once for operators (non-blocking).
    try {
      cmd.ui.notify(
        `ccroute Mod ${MOD_VERSION} loaded (${MOD_API_VERSION}; ${compatibility.status})`,
      );
    } catch {
      /* headless */
    }
  };
}

/** Default export: CommandCode Mod factory. */
export default createCcrouteMod({
  commandCodeVersion: "1.4.1",
});
