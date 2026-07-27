/**
 * Bootstrap vs refresh semantics.
 *
 * Bootstrap: install seed ONLY when no valid snapshot exists.
 * Never claims current freshness (preserves seed retrievedAt).
 * Never replaces a newer valid snapshot.
 */

import { existsSync, readFileSync } from "node:fs";
import type { DealSnapshot } from "../domain/deal.js";
import { DealSnapshotSchema } from "../domain/deal.js";
import type { PricingSnapshot } from "../domain/model.js";
import { PricingSnapshotSchema } from "../domain/model.js";
import {
  computeDealSourceHash,
  computePricingSourceHash,
  dealsSnapshotPath,
  loadSeedDealSnapshot,
  loadSeedPricingSnapshot,
  pricingSnapshotPath,
  saveDealSnapshot,
  savePricingSnapshot,
  sha256,
} from "../pricing/snapshot.js";

export interface BootstrapResult {
  ok: boolean;
  wrote: boolean;
  reason: string;
  claimsFreshness: false;
  snapshotRetrievedAt?: string;
  source?: string;
  isSeed: boolean;
}

function fileHoldsValidPricing(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = PricingSnapshotSchema.safeParse(raw);
    if (!parsed.success) return false;
    const expected = computePricingSourceHash(parsed.data.models);
    return parsed.data.sourceHash === expected;
  } catch {
    return false;
  }
}

function fileHoldsValidDeals(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = DealSnapshotSchema.safeParse(raw);
    if (!parsed.success) return false;
    const expected = computeDealSourceHash(parsed.data.deals);
    return parsed.data.sourceHash === expected;
  } catch {
    return false;
  }
}

/**
 * Bootstrap pricing from seed if no valid persisted snapshot.
 * Preserves seed.retrievedAt — does not stamp "now".
 */
export function bootstrapPricingSnapshot(): BootstrapResult {
  const path = pricingSnapshotPath();
  if (fileHoldsValidPricing(path)) {
    const current = JSON.parse(readFileSync(path, "utf8")) as PricingSnapshot;
    return {
      ok: true,
      wrote: false,
      reason: "Valid pricing snapshot already exists; bootstrap refused to overwrite",
      claimsFreshness: false,
      snapshotRetrievedAt: current.retrievedAt,
      source: current.source,
      isSeed: /seed/i.test(current.source ?? ""),
    };
  }

  const seed = loadSeedPricingSnapshot();
  const next: PricingSnapshot = {
    ...seed,
    retrievedAt: seed.retrievedAt,
    source: seed.source.includes("seed") ? seed.source : `seed:${seed.source}`,
    sourceHash: computePricingSourceHash(seed.models),
  };
  savePricingSnapshot(next);
  return {
    ok: true,
    wrote: true,
    reason: "Bootstrapped pricing from bundled seed (not claimed fresh)",
    claimsFreshness: false,
    snapshotRetrievedAt: next.retrievedAt,
    source: next.source,
    isSeed: true,
  };
}

export function bootstrapDealSnapshot(): BootstrapResult {
  const path = dealsSnapshotPath();
  if (fileHoldsValidDeals(path)) {
    const current = JSON.parse(readFileSync(path, "utf8")) as DealSnapshot;
    return {
      ok: true,
      wrote: false,
      reason: "Valid deals snapshot already exists; bootstrap refused to overwrite",
      claimsFreshness: false,
      snapshotRetrievedAt: current.retrievedAt,
      source: current.source,
      isSeed: /seed/i.test(current.source ?? ""),
    };
  }

  const seed = loadSeedDealSnapshot();
  const next: DealSnapshot = {
    ...seed,
    retrievedAt: seed.retrievedAt,
    source: seed.source.includes("seed") ? seed.source : `seed:${seed.source}`,
    sourceHash: computeDealSourceHash(seed.deals),
  };
  saveDealSnapshot(next);
  return {
    ok: true,
    wrote: true,
    reason: "Bootstrapped deals from bundled seed (not claimed fresh)",
    claimsFreshness: false,
    snapshotRetrievedAt: next.retrievedAt,
    source: next.source,
    isSeed: true,
  };
}

export function bootstrapBoth(): {
  pricing: BootstrapResult;
  deals: BootstrapResult;
} {
  return {
    pricing: bootstrapPricingSnapshot(),
    deals: bootstrapDealSnapshot(),
  };
}

/** Hash of currently loaded pricing+deals for generation tracking */
export function currentSnapshotFingerprint(): string {
  const pPath = pricingSnapshotPath();
  const dPath = dealsSnapshotPath();
  const p = fileHoldsValidPricing(pPath)
    ? (JSON.parse(readFileSync(pPath, "utf8")) as PricingSnapshot)
    : loadSeedPricingSnapshot();
  const d = fileHoldsValidDeals(dPath)
    ? (JSON.parse(readFileSync(dPath, "utf8")) as DealSnapshot)
    : loadSeedDealSnapshot();
  return sha256(
    JSON.stringify({
      p: p.sourceHash,
      d: d.sourceHash,
      pr: p.retrievedAt,
      dr: d.retrievedAt,
    }),
  );
}
