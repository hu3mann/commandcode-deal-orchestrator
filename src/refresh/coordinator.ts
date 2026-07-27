/**
 * Coordinated refresh: lease + backoff + atomic network refresh.
 * Never blocks routing; callers decide async vs sync.
 */

import { resolveCmdPath } from "../discovery/commandcode-cli.js";
import { fetchLiveModelIds } from "../discovery/model-catalog.js";
import { refreshPricingFromOfficial } from "../pricing/refresh.js";
import {
  computePricingSourceHash,
  loadPricingSnapshot,
  savePricingSnapshot,
} from "../pricing/snapshot.js";
import { computeNextEligibleAt, isBackoffActive } from "./backoff.js";
import { currentSnapshotFingerprint } from "./bootstrap.js";
import { tryAcquireLease } from "./lease.js";
import { loadRefreshState, saveRefreshState } from "./state.js";
import type { RefreshRunOptions, RefreshRunResult, RefreshState } from "./types.js";

function mergeLiveCatalogAvailability(env?: NodeJS.ProcessEnv): {
  ok: boolean;
  error?: string;
} {
  const cmd = resolveCmdPath(undefined, env);
  if (!cmd) return { ok: false, error: "CommandCode `cmd` not found" };
  const live = fetchLiveModelIds(cmd);
  if (live.error) return { ok: false, error: live.error };
  if (!live.ids.length) return { ok: false, error: "Live catalog empty" };
  const liveSet = new Set(live.ids);
  const snap = loadPricingSnapshot();
  const next = {
    ...snap,
    // Preserve retrievedAt — live catalog is availability only, not pricing freshness
    source: `${snap.source} + cmd --list-models`,
    models: snap.models.map((m) =>
      liveSet.has(m.id) || m.availability === "expired_deal"
        ? m
        : { ...m, availability: "unavailable" as const },
    ),
  };
  next.sourceHash = computePricingSourceHash(next.models);
  savePricingSnapshot(next);
  return { ok: true };
}

async function defaultNetworkRefresh(opts: RefreshRunOptions): Promise<{
  ok: boolean;
  error?: string;
  preservedPrior: boolean;
  snapshotHash?: string;
}> {
  // models-live: availability merge only (no official HTML, no freshness claim)
  if (opts.mode === "models-live") {
    const merged = mergeLiveCatalogAvailability(opts.env);
    if (!merged.ok) {
      return { ok: false, error: merged.error, preservedPrior: true };
    }
    return {
      ok: true,
      preservedPrior: false,
      snapshotHash: currentSnapshotFingerprint(),
    };
  }

  const result = await refreshPricingFromOfficial({
    allowNetwork: opts.allowNetwork !== false,
    fetchImpl: opts.fetchImpl,
  });

  if (result.ok && !opts.skipModelsLive) {
    mergeLiveCatalogAvailability(opts.env);
  }

  return {
    ok: result.ok,
    error: result.error,
    preservedPrior: result.preservedPrior,
    snapshotHash: result.ok ? currentSnapshotFingerprint() : undefined,
  };
}

export async function runCoordinatedRefresh(
  opts: RefreshRunOptions = {},
): Promise<RefreshRunResult> {
  const now = opts.now ?? new Date();
  const mode = opts.mode ?? (opts.allowNetwork === false ? "bootstrap" : "network");
  let state = loadRefreshState(opts.stateDir);

  // Backoff gate
  if (!opts.force) {
    const bo = isBackoffActive(state, now);
    if (bo.active) {
      return {
        ok: true,
        skipped: true,
        reason: `Backoff active until ${bo.nextEligibleAt} (${bo.remainingMs}ms remaining)`,
        mode,
        leaseAcquired: false,
        networkAttempted: false,
        preservedPrior: true,
        state,
      };
    }
  }

  const acquired = tryAcquireLease({
    stateRoot: opts.stateDir,
    now,
    breakStaleOnly: opts.breakStaleLease,
    force: false,
  });

  if (!acquired.ok) {
    // Healthy lease → clean skip (concurrency path)
    return {
      ok: true,
      skipped: true,
      reason: acquired.reason,
      mode,
      leaseAcquired: false,
      networkAttempted: false,
      preservedPrior: true,
      state: acquired.state,
    };
  }

  const { handle } = acquired;
  let result: RefreshRunResult | undefined;
  try {
    state = {
      ...handle.state,
      lastAttemptAt: now.toISOString(),
      mode,
      activeLease: handle.lease,
    };
    saveRefreshState(state, opts.stateDir);

    let net: {
      ok: boolean;
      error?: string;
      preservedPrior: boolean;
      snapshotHash?: string;
    };
    try {
      net = opts.networkRefresh ? await opts.networkRefresh() : await defaultNetworkRefresh(opts);
    } catch (e) {
      net = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        preservedPrior: true,
      };
    }

    if (net.ok) {
      const successAt = new Date().toISOString();
      const prev = loadRefreshState(opts.stateDir);
      state = {
        ...prev,
        lastAttemptAt: now.toISOString(),
        lastSuccessAt: successAt,
        lastError: null,
        failureCount: 0,
        nextEligibleAttemptAt: null,
        mode,
        snapshotHash: net.snapshotHash ?? currentSnapshotFingerprint(),
        snapshotGeneration: (prev.snapshotGeneration ?? 0) + 1,
        activeLease: handle.lease,
      };
      saveRefreshState(state, opts.stateDir);
      result = {
        ok: true,
        skipped: false,
        mode,
        leaseAcquired: true,
        networkAttempted: true,
        preservedPrior: false,
        state,
      };
    } else {
      const prev = loadRefreshState(opts.stateDir);
      const failureCount = (prev.failureCount ?? 0) + 1;
      state = {
        ...prev,
        lastAttemptAt: now.toISOString(),
        lastError: net.error ?? "refresh failed",
        failureCount,
        nextEligibleAttemptAt: computeNextEligibleAt(failureCount, now),
        mode,
        activeLease: handle.lease,
      };
      saveRefreshState(state, opts.stateDir);
      result = {
        ok: false,
        skipped: false,
        reason: net.error,
        error: net.error,
        mode,
        leaseAcquired: true,
        networkAttempted: true,
        preservedPrior: net.preservedPrior,
        state,
      };
    }
  } finally {
    handle.release();
  }

  // Return post-release state so callers see activeLease=null
  const finalState = loadRefreshState(opts.stateDir);
  if (!result) {
    return {
      ok: false,
      skipped: false,
      error: "refresh aborted",
      mode,
      leaseAcquired: true,
      networkAttempted: true,
      preservedPrior: true,
      state: finalState,
    };
  }
  return { ...result, state: finalState };
}

export function getRefreshStatus(stateRoot?: string): {
  state: RefreshState;
  backoff: ReturnType<typeof isBackoffActive>;
  leaseStale: boolean;
} {
  const state = loadRefreshState(stateRoot);
  const now = new Date();
  return {
    state,
    backoff: isBackoffActive(state, now),
    leaseStale: state.activeLease ? Date.parse(state.activeLease.expiresAt) <= now.getTime() : true,
  };
}
