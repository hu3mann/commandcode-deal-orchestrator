import type { DealSnapshot } from "../domain/deal.js";
import type { PricingSnapshot } from "../domain/model.js";
import {
  loadSeedDealSnapshot,
  loadSeedPricingSnapshot,
  saveDealSnapshot,
  savePricingSnapshot,
  sha256,
} from "./snapshot.js";

export interface RefreshResult {
  ok: boolean;
  error?: string;
  preservedPrior: boolean;
  snapshot?: PricingSnapshot | DealSnapshot;
}

/**
 * Offline-safe refresh: re-validates seed/official bundled snapshot.
 * Live HTML parsing is isolated here; network failures preserve prior snapshot.
 */
export async function refreshPricingFromOfficial(options?: {
  fetchImpl?: typeof fetch;
  allowNetwork?: boolean;
}): Promise<RefreshResult> {
  try {
    if (options?.allowNetwork && options.fetchImpl) {
      // Optional network path — only used by `deals refresh --network`.
      // MVP keeps bundled seed as authoritative when network fails.
      try {
        const res = await options.fetchImpl("https://commandcode.ai/docs/resources/pricing-limits");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        // We do not invent prices from HTML without fixtures in MVP;
        // success means we could reach the page; keep seed rates.
        void html;
      } catch (e) {
        return {
          ok: false,
          error: `Network refresh failed; prior snapshot preserved: ${(e as Error).message}`,
          preservedPrior: true,
        };
      }
    }

    const seed = loadSeedPricingSnapshot();
    const next: PricingSnapshot = {
      ...seed,
      retrievedAt: new Date().toISOString(),
      source: "seed+official-bundled",
      sourceHash: sha256(JSON.stringify(seed.models)),
    };
    savePricingSnapshot(next);
    return { ok: true, preservedPrior: false, snapshot: next };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      preservedPrior: true,
    };
  }
}

export async function refreshDealsFromOfficial(options?: {
  fetchImpl?: typeof fetch;
  allowNetwork?: boolean;
}): Promise<RefreshResult> {
  try {
    if (options?.allowNetwork && options.fetchImpl) {
      try {
        const res = await options.fetchImpl("https://commandcode.ai/docs/resources/pricing-limits");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await res.text();
      } catch (e) {
        return {
          ok: false,
          error: `Deal refresh failed; prior snapshot preserved: ${(e as Error).message}`,
          preservedPrior: true,
        };
      }
    }
    const seed = loadSeedDealSnapshot();
    const next: DealSnapshot = {
      ...seed,
      retrievedAt: new Date().toISOString(),
      sourceHash: sha256(JSON.stringify(seed.deals)),
    };
    saveDealSnapshot(next);
    return { ok: true, preservedPrior: false, snapshot: next };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      preservedPrior: true,
    };
  }
}
