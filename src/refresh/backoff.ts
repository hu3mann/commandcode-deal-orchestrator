import { DEFAULT_BACKOFF_MS, DEFAULT_JITTER_RATIO, type RefreshState } from "./types.js";

export interface BackoffConfig {
  stepsMs: readonly number[];
  jitterRatio: number;
}

export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  stepsMs: DEFAULT_BACKOFF_MS,
  jitterRatio: DEFAULT_JITTER_RATIO,
};

export function backoffDelayMs(
  failureCount: number,
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
): number {
  if (failureCount <= 0) return 0;
  const idx = Math.min(failureCount - 1, config.stepsMs.length - 1);
  return config.stepsMs[idx]!;
}

/**
 * Bounded jitter in [0, delay * jitterRatio]. Deterministic when rng provided.
 */
export function applyJitter(
  delayMs: number,
  jitterRatio = DEFAULT_JITTER_RATIO,
  rng: () => number = Math.random,
): number {
  if (delayMs <= 0 || jitterRatio <= 0) return delayMs;
  const j = Math.min(1, Math.max(0, jitterRatio));
  return Math.floor(delayMs * (1 + rng() * j));
}

export function isBackoffActive(
  state: RefreshState,
  now = new Date(),
): { active: boolean; nextEligibleAt: string | null; remainingMs: number } {
  if (!state.nextEligibleAttemptAt) {
    return { active: false, nextEligibleAt: null, remainingMs: 0 };
  }
  const next = Date.parse(state.nextEligibleAttemptAt);
  if (Number.isNaN(next)) {
    return { active: false, nextEligibleAt: null, remainingMs: 0 };
  }
  const remaining = next - now.getTime();
  if (remaining <= 0) {
    return { active: false, nextEligibleAt: state.nextEligibleAttemptAt, remainingMs: 0 };
  }
  return {
    active: true,
    nextEligibleAt: state.nextEligibleAttemptAt,
    remainingMs: remaining,
  };
}

export function computeNextEligibleAt(
  failureCount: number,
  now = new Date(),
  config: BackoffConfig = DEFAULT_BACKOFF_CONFIG,
  rng: () => number = Math.random,
): string {
  const delay = applyJitter(backoffDelayMs(failureCount, config), config.jitterRatio, rng);
  return new Date(now.getTime() + delay).toISOString();
}
