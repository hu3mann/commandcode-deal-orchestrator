import type { DealSnapshot } from "../domain/deal.js";
import type { PricingSnapshot } from "../domain/model.js";
import { mergeOfficialIntoSnapshots } from "./merge-official.js";
import { parseOfficialPricingHtml } from "./official-html.js";
import { OFFICIAL_PRICING_SOURCE } from "./official-source.js";
import {
  PartialCommitError,
  commitPricingAndDeals,
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

/**
 * §15 step 2 requires validating both HTTP status AND content type. A 200-response WAF
 * or maintenance page previously passed as long as it exceeded 100 bytes and produced one
 * regex match. `res.headers` is only checked when present (functions, not just plain
 * objects) so hand-built fetch mocks that omit headers entirely (legitimate in tests)
 * are not penalized — only a header that is present and explicitly non-HTML is rejected.
 */
function isAcceptableHtmlContentType(res: Response): { ok: true } | { ok: false; error: string } {
  const contentType =
    typeof res.headers?.get === "function" ? res.headers.get("content-type") : null;
  if (contentType && !/text\/html/i.test(contentType)) {
    return { ok: false, error: `Unexpected content-type "${contentType}"; expected text/html` };
  }
  return { ok: true };
}

async function fetchOfficialHtml(
  fetchImpl: typeof fetch,
): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(OFFICIAL_PRICING_SOURCE);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const contentTypeCheck = isAcceptableHtmlContentType(res);
    if (!contentTypeCheck.ok) return contentTypeCheck;
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
      // Commit both files as a single staged operation: both are fully validated and
      // written+fsynced to temp files before either live file is touched, so a failure
      // anywhere in staging leaves prior state genuinely untouched. See
      // commitPricingAndDeals() for what happens if the second (deals) rename itself
      // fails after the first (pricing) rename already succeeded.
      commitPricingAndDeals(merged.pricing, merged.deals);
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
    // A PartialCommitError means state was already partially mutated (pricing replaced,
    // deals commit failed) — reporting preservedPrior: true here would be exactly the
    // "silently claims prior preserved after pricing was already replaced" defect.
    return {
      ok: false,
      error: (e as Error).message,
      preservedPrior: !(e instanceof PartialCommitError),
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
        // Propagate the inner refresh's own preservedPrior verdict rather than assuming
        // true — a partial commit there means state was NOT preserved.
        return {
          ok: false,
          error: pricing.error,
          preservedPrior: pricing.preservedPrior,
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
