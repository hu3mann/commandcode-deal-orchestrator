/**
 * Non-blocking session-start refresh trigger for the CommandCode Mod.
 * Never awaits network; never blocks routing; never spends on models.
 */

import { spawn } from "node:child_process";
import {
  classifySnapshotFreshness,
  loadPricingSnapshot,
  snapshotAgeMs,
} from "../pricing/snapshot.js";
import { isBackoffActive } from "./backoff.js";
import { getRefreshStatus } from "./coordinator.js";
import { loadRefreshState } from "./state.js";

export interface SessionStartRefreshPlan {
  shouldAttempt: boolean;
  reason: string;
  pricingFreshness: "fresh" | "acceptable" | "stale" | "unknown";
  staticContextLines: string[];
}

export function planSessionStartRefresh(opts?: {
  now?: Date;
  stateRoot?: string;
  routingEnabled?: boolean;
}): SessionStartRefreshPlan {
  const now = opts?.now ?? new Date();
  const status = getRefreshStatus(opts?.stateRoot);
  let pricingFreshness: SessionStartRefreshPlan["pricingFreshness"] = "unknown";
  try {
    const pricing = loadPricingSnapshot();
    const age = snapshotAgeMs(pricing.retrievedAt, now.getTime());
    pricingFreshness = classifySnapshotFreshness(age);
  } catch {
    pricingFreshness = "unknown";
  }

  const lines = [
    "ccroute routing is enabled.",
    "Explicit repository writes still require user authorization.",
    "Child sessions may not invoke ccroute.",
    `Current pricing state: ${pricingFreshness}.`,
  ];

  if (opts?.routingEnabled === false) {
    return {
      shouldAttempt: false,
      reason: "routing disabled",
      pricingFreshness,
      staticContextLines: lines,
    };
  }

  const bo = isBackoffActive(status.state, now);
  if (bo.active) {
    return {
      shouldAttempt: false,
      reason: `backoff until ${bo.nextEligibleAt}`,
      pricingFreshness,
      staticContextLines: lines,
    };
  }

  if (status.state.activeLease && !status.leaseStale) {
    return {
      shouldAttempt: false,
      reason: "lease held",
      pricingFreshness,
      staticContextLines: lines,
    };
  }

  if (pricingFreshness === "fresh") {
    return {
      shouldAttempt: false,
      reason: "snapshot fresh",
      pricingFreshness,
      staticContextLines: lines,
    };
  }

  return {
    shouldAttempt: true,
    reason: `pricing ${pricingFreshness}; scheduling nonblocking refresh`,
    pricingFreshness,
    staticContextLines: lines,
  };
}

/**
 * Spawn detached `ccroute refresh run --session-start` and return immediately.
 * Failures are swallowed — session must not hard-fail.
 */
export function spawnNonblockingRefresh(opts: {
  ccroutePath: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
}): { spawned: boolean; error?: string } {
  try {
    const child = spawn(
      opts.ccroutePath,
      ["refresh", "run", "--session-start", ...(opts.extraArgs ?? [])],
      {
        detached: true,
        stdio: "ignore",
        env: opts.env ?? process.env,
        shell: false,
      },
    );
    child.unref();
    return { spawned: true };
  } catch (e) {
    return {
      spawned: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export function oneLineRefreshStatus(stateRoot?: string): string {
  const state = loadRefreshState(stateRoot);
  if (state.lastError && state.failureCount > 0) {
    return `ccroute refresh last error: ${state.lastError}`;
  }
  if (state.lastSuccessAt) {
    return `ccroute refresh last success: ${state.lastSuccessAt}`;
  }
  return "ccroute refresh: no successful run yet";
}
