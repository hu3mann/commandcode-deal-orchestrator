import { z } from "zod";

export const REFRESH_STATE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_BACKOFF_MS = [
  15 * 60 * 1000, // 15m
  60 * 60 * 1000, // 1h
  4 * 60 * 60 * 1000, // 4h
  12 * 60 * 60 * 1000, // 12h max
] as const;
export const DEFAULT_JITTER_RATIO = 0.1;

export type RefreshMode = "bootstrap" | "network" | "models-live" | "scheduled" | "session-start";

export const RefreshLeaseSchema = z.object({
  ownerPid: z.number().int().nonnegative(),
  ownerInstance: z.string().min(1),
  acquiredAt: z.string().min(1),
  expiresAt: z.string().min(1),
});
export type RefreshLease = z.infer<typeof RefreshLeaseSchema>;

export const RefreshStateSchema = z.object({
  schemaVersion: z.literal(1),
  lastAttemptAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  failureCount: z.number().int().nonnegative(),
  nextEligibleAttemptAt: z.string().nullable(),
  activeLease: RefreshLeaseSchema.nullable(),
  mode: z.enum(["bootstrap", "network", "models-live", "scheduled", "session-start"]).nullable(),
  snapshotHash: z.string().nullable(),
  snapshotGeneration: z.number().int().nonnegative(),
});
export type RefreshState = z.infer<typeof RefreshStateSchema>;

export function emptyRefreshState(): RefreshState {
  return {
    schemaVersion: 1,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    failureCount: 0,
    nextEligibleAttemptAt: null,
    activeLease: null,
    mode: null,
    snapshotHash: null,
    snapshotGeneration: 0,
  };
}

export interface RefreshRunOptions {
  force?: boolean;
  breakStaleLease?: boolean;
  allowNetwork?: boolean;
  mode?: RefreshMode;
  /** Injected now for tests */
  now?: Date;
  /** Injected fetch */
  fetchImpl?: typeof fetch;
  /** Injected state dir */
  stateDir?: string;
  /** Skip models live-catalog merge */
  skipModelsLive?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Test seam: override network refresh implementation */
  networkRefresh?: () => Promise<{
    ok: boolean;
    error?: string;
    preservedPrior: boolean;
    snapshotHash?: string;
  }>;
}

export interface RefreshRunResult {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  mode: RefreshMode;
  leaseAcquired: boolean;
  networkAttempted: boolean;
  preservedPrior: boolean;
  state: RefreshState;
  error?: string;
}
