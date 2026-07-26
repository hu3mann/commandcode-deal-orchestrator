import type { DealRecord, DealSnapshot } from "../domain/deal.js";
import type { Deal, ModelPricing, PricingSnapshot } from "../domain/model.js";
import {
  type ParsedOfficialDeal,
  type ParsedOfficialPricing,
  buildPageIdResolver,
} from "./official-html.js";
import { sha256 } from "./snapshot.js";

export type MergeOfficialResult = {
  pricing: PricingSnapshot;
  deals: DealSnapshot;
  updatedModelIds: string[];
  unmappedPageIds: string[];
  updatedDealModelIds: string[];
};

function dealFromParsed(p: ParsedOfficialDeal, now: Date): Deal {
  if (p.free) {
    return {
      type: "free",
      label: p.label,
      expiresAt: p.expiresAt,
      capacityLimited: Boolean(p.endsWhen && /capacity/i.test(p.endsWhen)),
    };
  }
  if (p.expiresAt && Date.parse(p.expiresAt) <= now.getTime()) {
    return {
      type: "temporary_rate",
      label: p.label,
      expiresAt: p.expiresAt,
    };
  }
  return {
    type: "permanent_price_reduction",
    label: p.label,
    expiresAt: p.expiresAt,
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
    if (deal.type === "free") {
      next.priceBasis = "post_discount";
      const expired = deal.expiresAt ? Date.parse(deal.expiresAt) <= now.getTime() : false;
      next.availability = expired ? "expired_deal" : "available";
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
    sourceHash: sha256(JSON.stringify(models)),
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
      label: deal.label,
      expiresAt: deal.expiresAt ?? null,
      capacityLimited: deal.capacityLimited,
    });
    updatedDealModelIds.push(modelId);
  }

  const deals: DealSnapshot = {
    schemaVersion: 1,
    retrievedAt,
    source,
    sourceHash: sha256(JSON.stringify([...dealMap.values()])),
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
