/**
 * Strict live-catalog reconciliation (not "adopt live").
 *
 * Maps official pricing snapshot model IDs to current `cmd --list-models` IDs.
 * Never transfers rates when mapping is ambiguous or incomplete.
 */

import type { ModelPricing, PricingSnapshot } from "../domain/model.js";
import { computePricingSourceHash, loadPricingSnapshot, savePricingSnapshot } from "./snapshot.js";

export type ReconcileBucket = "mapped" | "unmapped" | "ambiguous" | "quarantined" | "removed";

export interface ReconcileEntry {
  pricingId: string;
  liveId?: string;
  bucket: ReconcileBucket;
  reason: string;
}

export interface ReconcileReport {
  ok: boolean;
  mapped: ReconcileEntry[];
  unmapped: ReconcileEntry[];
  ambiguous: ReconcileEntry[];
  quarantined: ReconcileEntry[];
  removed: ReconcileEntry[];
  liveOnly: string[];
  messages: string[];
  wrote: boolean;
}

function normalizeModelToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function splitProviderModel(id: string): { provider: string; name: string } {
  const i = id.indexOf("/");
  if (i < 0) return { provider: "", name: id };
  return { provider: id.slice(0, i), name: id.slice(i + 1) };
}

/**
 * Map one pricing ID to a live ID under strict rules:
 * 1. exact full ID
 * 2. exact provider + normalized model name → unique candidate only
 * Otherwise QUARANTINED_UNMAPPED
 */
export function mapPricingIdToLive(
  pricingId: string,
  liveIds: string[],
): { liveId?: string; bucket: ReconcileBucket; reason: string } {
  if (liveIds.includes(pricingId)) {
    return { liveId: pricingId, bucket: "mapped", reason: "exact full ID" };
  }

  const { provider, name } = splitProviderModel(pricingId);
  const normName = normalizeModelToken(name || pricingId);
  const candidates = liveIds.filter((live) => {
    const parts = splitProviderModel(live);
    if (provider && parts.provider.toLowerCase() !== provider.toLowerCase()) return false;
    return normalizeModelToken(parts.name || live) === normName;
  });

  if (candidates.length === 1) {
    return {
      liveId: candidates[0],
      bucket: "mapped",
      reason: "exact provider + normalized official model name (unique)",
    };
  }
  if (candidates.length > 1) {
    return {
      bucket: "ambiguous",
      reason: `multiple live candidates: ${candidates.join(", ")}`,
    };
  }
  return {
    bucket: "quarantined",
    reason: "QUARANTINED_UNMAPPED — no unique exact/provider+name match",
  };
}

export function reconcileLiveCatalog(opts: {
  liveIds: string[];
  pricing?: PricingSnapshot;
  /** When true, mark unmapped/ambiguous models unavailable and persist snapshot */
  applyAvailability?: boolean;
}): ReconcileReport {
  const pricing = opts.pricing ?? loadPricingSnapshot();
  const liveIds = [...new Set(opts.liveIds)].sort();
  const liveSet = new Set(liveIds);
  const messages: string[] = [];
  const mapped: ReconcileEntry[] = [];
  const unmapped: ReconcileEntry[] = [];
  const ambiguous: ReconcileEntry[] = [];
  const quarantined: ReconcileEntry[] = [];
  const removed: ReconcileEntry[] = [];

  const nextModels: ModelPricing[] = [];

  for (const model of pricing.models) {
    const result = mapPricingIdToLive(model.id, liveIds);
    const entry: ReconcileEntry = {
      pricingId: model.id,
      liveId: result.liveId,
      bucket: result.bucket,
      reason: result.reason,
    };

    if (result.bucket === "mapped") {
      mapped.push(entry);
      // Never rewrite rates or IDs — only optional availability when exact live presence differs
      if (opts.applyAvailability) {
        nextModels.push({
          ...model,
          availability: model.availability === "expired_deal" ? "expired_deal" : "available",
        });
      } else {
        nextModels.push(model);
      }
      continue;
    }

    if (result.bucket === "ambiguous") {
      ambiguous.push(entry);
      quarantined.push({
        ...entry,
        bucket: "quarantined",
        reason: `${entry.reason}; rates not transferred`,
      });
      if (opts.applyAvailability) {
        nextModels.push({ ...model, availability: "unavailable" });
      } else {
        nextModels.push(model);
      }
      continue;
    }

    // quarantined / unmapped
    unmapped.push({ ...entry, bucket: "unmapped" });
    quarantined.push(entry);
    if (opts.applyAvailability) {
      nextModels.push({ ...model, availability: "unavailable" });
    } else {
      nextModels.push(model);
    }
  }

  // Live-only: present in catalog but not in pricing snapshot (informational — no rate adoption)
  const pricingIds = new Set(pricing.models.map((m) => m.id));
  const liveOnly = liveIds.filter((id) => !pricingIds.has(id));
  for (const id of liveOnly) {
    // also check normalized mapping reverse — still never invent rates
    const reverse = pricing.models.find((m) => mapPricingIdToLive(m.id, [id]).liveId === id);
    if (!reverse) {
      removed.push({
        pricingId: "(none)",
        liveId: id,
        bucket: "removed",
        reason: "live catalog id with no pricing snapshot entry — rates not invented",
      });
    }
  }

  messages.push(
    `mapped=${mapped.length} unmapped=${unmapped.length} ambiguous=${ambiguous.length} quarantined=${quarantined.length} liveOnly=${liveOnly.length}`,
  );
  messages.push("Rates are never transferred on ambiguous or family-label matches.");

  let wrote = false;
  if (opts.applyAvailability) {
    const next: PricingSnapshot = {
      ...pricing,
      // Preserve retrievedAt — this is availability reconciliation, not pricing freshness
      source: `${pricing.source} + reconcile-live-catalog`,
      models: nextModels,
      sourceHash: computePricingSourceHash(nextModels),
    };
    savePricingSnapshot(next);
    wrote = true;
    messages.push("Updated availability flags only; retrieval timestamps preserved");
  }

  void liveSet;
  return {
    ok: true,
    mapped,
    unmapped,
    ambiguous,
    quarantined,
    removed,
    liveOnly,
    messages,
    wrote,
  };
}
