import { isDealExpired, isDealPending } from "../domain/deal.js";
import type { DealRecord, DealSnapshot } from "../domain/deal.js";
import type { Deal, ModelPricing, PricingSnapshot } from "../domain/model.js";
import {
  type ParsedOfficialDeal,
  type ParsedOfficialPricing,
  buildPageIdResolver,
} from "./official-html.js";
import { computeDealSourceHash, computePricingSourceHash } from "./snapshot.js";

export type MergeOfficialResult = {
  pricing: PricingSnapshot;
  deals: DealSnapshot;
  updatedModelIds: string[];
  unmappedPageIds: string[];
  updatedDealModelIds: string[];
};

function dealFromParsed(p: ParsedOfficialDeal, _now: Date): Deal {
  if (p.free) {
    return {
      type: "free",
      kind: "free",
      label: p.label,
      expiresAt: p.expiresAt,
      startsAt: p.startsAt,
      capacityLimited: Boolean(p.endsWhen && /capacity/i.test(p.endsWhen)),
    };
  }

  // §14 fix: the presence of an expiresAt — whether already past or still in the future —
  // makes a deal temporary by definition; only a deal with NO end date is a genuine
  // permanent rate. (The previous logic was inverted: a still-active, time-bound deal
  // was classified "permanent_price_reduction", and only became "temporary_rate" once it
  // had *already* expired.)
  const isTemporary = Boolean(p.expiresAt);
  const kind =
    p.usageMultiplier !== undefined
      ? "multiplier"
      : isTemporary
        ? "temporary_rate"
        : "permanent_rate";

  return {
    type: isTemporary ? "temporary_rate" : "permanent_price_reduction",
    kind,
    label: p.label,
    expiresAt: p.expiresAt,
    startsAt: p.startsAt,
    ...(p.usageMultiplier !== undefined ? { multiplier: p.usageMultiplier } : {}),
  };
}

function applyRate(
  model: ModelPricing,
  rate: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheWritePerMillion?: number;
  },
  deal: Deal | undefined,
  now: Date,
): ModelPricing {
  const next: ModelPricing = {
    ...model,
    inputPerMillion: rate.inputPerMillion,
    outputPerMillion: rate.outputPerMillion,
    cacheReadPerMillion: rate.cacheReadPerMillion,
  };
  if (rate.cacheWritePerMillion !== undefined) {
    next.cacheWritePerMillion = rate.cacheWritePerMillion;
  }
  // Flat rates from official table supersede tier tables for the base fields.
  // Keep tiers if present but prefer flat for calculator when set (calculator uses tiers when present).
  // For official refresh, drop tiers so flat post-discount rates apply unless model only had tiers.
  if (next.tiers?.length) {
    // Update first tier rates to match official flat when structure is simple
    next.tiers = next.tiers.map((t) => ({
      ...t,
      inputPerMillion: rate.inputPerMillion,
      outputPerMillion: rate.outputPerMillion,
      cacheReadPerMillion: rate.cacheReadPerMillion,
      ...(rate.cacheWritePerMillion !== undefined
        ? { cacheWritePerMillion: rate.cacheWritePerMillion }
        : {}),
    }));
  }

  if (deal) {
    next.deal = deal;
    if (isDealPending(deal.startsAt, now)) {
      // §14 startsAt gate: the deal exists but has not started yet — it must NOT be
      // applied. Record it (so it's visible ahead of time, e.g. via `ccroute deals
      // list`), but classify pricing exactly as if no deal were in effect.
      next.priceBasis =
        model.priceBasis === "temporary_introductory_rate"
          ? "temporary_introductory_rate"
          : "current_rate";
    } else if (deal.type === "free") {
      next.priceBasis = "post_discount";
      next.availability = isDealExpired(deal.expiresAt, now) ? "expired_deal" : "available";
    } else if (deal.type === "permanent_price_reduction") {
      next.priceBasis = "post_discount";
      next.availability = "available";
    } else {
      next.priceBasis =
        model.priceBasis === "temporary_introductory_rate"
          ? "temporary_introductory_rate"
          : "post_discount";
    }
  } else if (model.deal?.type === "free" || model.deal?.type === "permanent_price_reduction") {
    // Keep existing deal metadata if page had rates but no deal object for this model
    next.priceBasis = model.priceBasis;
  } else {
    next.priceBasis =
      model.priceBasis === "temporary_introductory_rate"
        ? "temporary_introductory_rate"
        : "current_rate";
  }

  return next;
}

/**
 * Merge parsed official page data into existing snapshots.
 * Only updates models already present in the base pricing snapshot (no invented IDs).
 */
export function mergeOfficialIntoSnapshots(options: {
  basePricing: PricingSnapshot;
  baseDeals: DealSnapshot;
  parsed: ParsedOfficialPricing;
  retrievedAt?: string;
  source?: string;
  now?: Date;
}): MergeOfficialResult {
  const now = options.now ?? new Date();
  const retrievedAt = options.retrievedAt ?? now.toISOString();
  const source = options.source ?? "https://commandcode.ai/docs/resources/pricing-limits";

  const resolve = buildPageIdResolver(options.basePricing.models.map((m) => m.id));
  const byId = new Map(options.basePricing.models.map((m) => [m.id, m]));

  const pageDealByModel = new Map<string, ParsedOfficialDeal>();
  for (const d of options.parsed.deals) {
    const resolved = resolve(d.pageModelId);
    if (resolved) pageDealByModel.set(resolved, d);
  }

  const updatedModelIds: string[] = [];
  const unmappedPageIds: string[] = [];

  for (const rate of options.parsed.rates) {
    const resolved = resolve(rate.pageId);
    if (!resolved) {
      unmappedPageIds.push(rate.pageId);
      continue;
    }
    const current = byId.get(resolved);
    if (!current) {
      unmappedPageIds.push(rate.pageId);
      continue;
    }
    const parsedDeal = pageDealByModel.get(resolved);
    const deal = parsedDeal ? dealFromParsed(parsedDeal, now) : current.deal;
    const next = applyRate(current, rate, deal, now);
    byId.set(resolved, next);
    updatedModelIds.push(resolved);
  }

  // Apply free deals even if rate row only synthesized
  for (const [modelId, parsedDeal] of pageDealByModel) {
    if (!parsedDeal.free) continue;
    const current = byId.get(modelId);
    if (!current) continue;
    if (updatedModelIds.includes(modelId)) continue;
    const deal = dealFromParsed(parsedDeal, now);
    if (isDealPending(deal.startsAt, now)) {
      // §14: not started yet — must not zero the rate out early. Leave the model as-is;
      // the deal will be picked up by a future refresh once it becomes active.
      continue;
    }
    byId.set(
      modelId,
      applyRate(
        current,
        {
          inputPerMillion: 0,
          outputPerMillion: 0,
          cacheReadPerMillion: 0,
        },
        deal,
        now,
      ),
    );
    updatedModelIds.push(modelId);
  }

  const models = options.basePricing.models.map((m) => byId.get(m.id) ?? m);
  const pricing: PricingSnapshot = {
    schemaVersion: 1,
    retrievedAt,
    source,
    sourceHash: computePricingSourceHash(models),
    models,
  };

  // Build deals snapshot from base + official deals for known models
  const dealMap = new Map<string, DealRecord>();
  for (const d of options.baseDeals.deals) {
    dealMap.set(d.modelId, d);
  }
  const updatedDealModelIds: string[] = [];
  for (const [modelId, parsedDeal] of pageDealByModel) {
    const deal = dealFromParsed(parsedDeal, now);
    dealMap.set(modelId, {
      modelId,
      type: deal.type,
      kind: deal.kind,
      label: deal.label,
      expiresAt: deal.expiresAt ?? null,
      startsAt: deal.startsAt ?? null,
      ...(deal.multiplier !== undefined ? { multiplier: deal.multiplier } : {}),
      capacityLimited: deal.capacityLimited,
    });
    updatedDealModelIds.push(modelId);
  }

  const deals: DealSnapshot = {
    schemaVersion: 1,
    retrievedAt,
    source,
    sourceHash: computeDealSourceHash([...dealMap.values()]),
    deals: [...dealMap.values()],
  };

  return {
    pricing,
    deals,
    updatedModelIds: [...new Set(updatedModelIds)].sort(),
    unmappedPageIds: [...new Set(unmappedPageIds)].sort(),
    updatedDealModelIds: [...new Set(updatedDealModelIds)].sort(),
  };
}
