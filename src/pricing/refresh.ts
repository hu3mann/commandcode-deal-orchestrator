import type { DealSnapshot } from "../domain/deal.js";
import type { PricingSnapshot } from "../domain/model.js";
import { mergeOfficialIntoSnapshots } from "./merge-official.js";
import { parseOfficialPricingHtml } from "./official-html.js";
import { OFFICIAL_PRICING_SOURCE } from "./official-source.js";
import {
  loadDealSnapshot,
  loadPricingSnapshot,
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
  /** Models whose rates/deals were updated from official HTML */
  updatedModelIds?: string[];
  unmappedPageIds?: string[];
  mode?: "seed" | "official-html";
}

async function fetchOfficialHtml(
  fetchImpl: typeof fetch,
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(OFFICIAL_PRICING_SOURCE);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    if (!html || html.length < 100) {
      return { ok: false, error: "Official page body empty or too short" };
    }
    return { ok: true, html };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Offline-safe refresh: re-validates seed/official bundled snapshot.
 * With allowNetwork, fetches the official page, parses rates/deals, and merges
 * into the last valid snapshot (never invents model IDs).
 * Network/parse failures preserve prior snapshot.
 */
export async function refreshPricingFromOfficial(options?: {
  fetchImpl?: typeof fetch;
  allowNetwork?: boolean;
}): Promise<RefreshResult> {
  try {
    if (options?.allowNetwork) {
      const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      if (!fetchImpl) {
        return {
          ok: false,
          error: "Network refresh failed; prior snapshot preserved: fetch unavailable",
          preservedPrior: true,
        };
      }
      const fetched = await fetchOfficialHtml(fetchImpl);
      if (!fetched.ok) {
        return {
          ok: false,
          error: `Network refresh failed; prior snapshot preserved: ${fetched.error}`,
          preservedPrior: true,
        };
      }
      const parsed = parseOfficialPricingHtml(fetched.html);
      if (parsed.rates.length === 0) {
        return {
          ok: false,
          error: "Official page parse produced no model rates; prior snapshot preserved",
          preservedPrior: true,
        };
      }
      const basePricing = loadPricingSnapshot();
      const baseDeals = loadDealSnapshot();
      const merged = mergeOfficialIntoSnapshots({
        basePricing,
        baseDeals,
        parsed,
        source: OFFICIAL_PRICING_SOURCE,
      });
      if (merged.updatedModelIds.length === 0) {
        return {
          ok: false,
          error:
            "Official page parse found rates but none mapped to known models; prior snapshot preserved",
          preservedPrior: true,
          unmappedPageIds: merged.unmappedPageIds,
        };
      }
      savePricingSnapshot(merged.pricing);
      saveDealSnapshot(merged.deals);
      return {
        ok: true,
        preservedPrior: false,
        snapshot: merged.pricing,
        updatedModelIds: merged.updatedModelIds,
        unmappedPageIds: merged.unmappedPageIds,
        mode: "official-html",
      };
    }

    const seed = loadSeedPricingSnapshot();
    const next: PricingSnapshot = {
      ...seed,
      retrievedAt: new Date().toISOString(),
      source: "seed+official-bundled",
      sourceHash: sha256(JSON.stringify(seed.models)),
    };
    savePricingSnapshot(next);
    return { ok: true, preservedPrior: false, snapshot: next, mode: "seed" };
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
    if (options?.allowNetwork) {
      // Pricing refresh already merges deals when network succeeds.
      // If called alone, run the same network path and return deals snapshot.
      const pricing = await refreshPricingFromOfficial(options);
      if (!pricing.ok) {
        return {
          ok: false,
          error: pricing.error,
          preservedPrior: true,
          unmappedPageIds: pricing.unmappedPageIds,
        };
      }
      const deals = loadDealSnapshot();
      return {
        ok: true,
        preservedPrior: false,
        snapshot: deals,
        updatedModelIds: pricing.updatedModelIds,
        unmappedPageIds: pricing.unmappedPageIds,
        mode: pricing.mode,
      };
    }

    const seed = loadSeedDealSnapshot();
    const next: DealSnapshot = {
      ...seed,
      retrievedAt: new Date().toISOString(),
      sourceHash: sha256(JSON.stringify(seed.deals)),
    };
    saveDealSnapshot(next);
    return { ok: true, preservedPrior: false, snapshot: next, mode: "seed" };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      preservedPrior: true,
    };
  }
}
