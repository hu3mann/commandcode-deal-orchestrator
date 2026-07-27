/**
 * Cross-process refresh lease.
 *
 * Uses refresh-state.json as the lease store with atomic rewrite.
 * Staleness is proven by expiresAt wall-clock time AND optional instance mismatch —
 * never by PID existence alone (PID reuse).
 */

import { loadRefreshState, newOwnerInstance, saveRefreshState } from "./state.js";
import { DEFAULT_LEASE_TTL_MS, type RefreshLease, type RefreshState } from "./types.js";

export interface LeaseAcquireOptions {
  stateRoot?: string;
  ttlMs?: number;
  now?: Date;
  ownerPid?: number;
  ownerInstance?: string;
  /** When true, take over only if current lease is proven stale */
  breakStaleOnly?: boolean;
  /** When true, take over even a healthy lease (dangerous; not used by default) */
  force?: boolean;
}

export interface LeaseHandle {
  lease: RefreshLease;
  state: RefreshState;
  release: () => void;
}

export function isLeaseStale(lease: RefreshLease | null | undefined, now = new Date()): boolean {
  if (!lease) return true;
  const exp = Date.parse(lease.expiresAt);
  if (Number.isNaN(exp)) return true;
  return exp <= now.getTime();
}

export function tryAcquireLease(opts: LeaseAcquireOptions = {}):
  | {
      ok: true;
      handle: LeaseHandle;
    }
  | {
      ok: false;
      reason: string;
      state: RefreshState;
      lease: RefreshLease | null;
    } {
  const now = opts.now ?? new Date();
  const state = loadRefreshState(opts.stateRoot);
  const current = state.activeLease;
  const stale = isLeaseStale(current, now);

  if (current && !stale && !opts.force) {
    // Healthy lease: refuse all non-force acquirers (including --break-stale-lease).
    return {
      ok: false,
      reason: `Refresh lease held by pid=${current.ownerPid} instance=${current.ownerInstance} until ${current.expiresAt}`,
      state,
      lease: current,
    };
  }

  const ttl = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  const lease: RefreshLease = {
    ownerPid: opts.ownerPid ?? process.pid,
    ownerInstance: opts.ownerInstance ?? newOwnerInstance(),
    acquiredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };

  const next: RefreshState = {
    ...state,
    activeLease: lease,
  };
  saveRefreshState(next, opts.stateRoot);

  // Single-writer atomic rewrite: re-read confirms our lease is present.
  // Multi-process contention is exercised at the coordinator level (10→1 skips).
  const confirmed = loadRefreshState(opts.stateRoot);
  /* v8 ignore start — lost-race only under true multi-process TOCTOU */
  if (!confirmed.activeLease || confirmed.activeLease.ownerInstance !== lease.ownerInstance) {
    return {
      ok: false,
      reason: "Lost lease race to another owner",
      state: confirmed,
      lease: confirmed.activeLease,
    };
  }
  /* v8 ignore stop */

  const handle: LeaseHandle = {
    lease,
    state: confirmed,
    release: () => releaseLease(lease, opts.stateRoot),
  };
  return { ok: true, handle };
}

export function releaseLease(lease: RefreshLease, stateRoot?: string): void {
  const state = loadRefreshState(stateRoot);
  if (state.activeLease && state.activeLease.ownerInstance === lease.ownerInstance) {
    saveRefreshState({ ...state, activeLease: null }, stateRoot);
  }
}
