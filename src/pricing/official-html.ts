/**
 * Parse Command Code official pricing-limits HTML (Next.js RSC payload).
 * Never invents model IDs — only extracts structured rates/deals present in the page.
 */

export type ParsedOfficialRate = {
  /** Page model id (short or provider/id) */
  pageId: string;
  name?: string;
  provider?: string;
  category?: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion?: number;
};

export type ParsedOfficialDeal = {
  /** Deal slug from page (e.g. deepseek-v4-pro-4x-usage) */
  dealId: string;
  /** Best-effort model page id this deal applies to */
  pageModelId: string;
  discountPercent: number;
  free: boolean;
  expiresAt: string | null;
  /** §14: instant the deal takes effect. null when the page doesn't publish one (deal is
   * already in effect). A deal must not be applied before this instant. */
  startsAt: string | null;
  endsWhen: string | null;
  label: string;
  /** §14 multiplier deal support: derived from an "-Nx-usage" dealId suffix (e.g. "-4x-
   * usage" -> 4). undefined for flat percent-off/free deals, which already carry their
   * final effective rate directly in the page's cost fields. */
  usageMultiplier?: number;
};

export type ParsedOfficialPricing = {
  rates: ParsedOfficialRate[];
  deals: ParsedOfficialDeal[];
};

const RATE_RE =
  /\\?"id\\?":\\?"([^"\\]+)\\?".{0,160}?\\?"inputCost\\?":([0-9.]+).{0,60}?\\?"outputCost\\?":([0-9.]+).{0,60}?\\?"cacheReadCost\\?":([0-9.]+)(?:.{0,60}?\\?"cacheWriteCost\\?":([0-9.]+))?/g;

const DEAL_RE =
  /\\?"deal\\?":\{\\?"id\\?":\\?"([^"\\]+)\\?",\\?"discountPercent\\?":(\d+)([^}]{0,160})\}/g;

/** Strip deal suffixes to recover the model page id. */
export function dealIdToPageModelId(dealId: string): string {
  let id = dealId;
  const suffixes = [/-4x-usage$/i, /-2x-usage$/i, /-\d+-off$/i, /-usage$/i];
  for (const s of suffixes) {
    id = id.replace(s, "");
  }
  return id;
}

const USAGE_MULTIPLIER_RE = /-(\d+)x-usage$/i;

/** Extract the usage multiplier from an "-Nx-usage" dealId suffix, e.g. 4 from
 * "deepseek-v4-pro-4x-usage". Returns undefined for deals that aren't multiplier-shaped
 * (flat percent-off or free deals). */
export function usageMultiplierFromDealId(dealId: string): number | undefined {
  const m = dealId.match(USAGE_MULTIPLIER_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function dealLabel(parsed: {
  dealId: string;
  discountPercent: number;
  free: boolean;
  expiresAt: string | null;
  endsWhen: string | null;
}): string {
  if (parsed.free && parsed.endsWhen) {
    return `free-${parsed.endsWhen.replace(/\s+/g, "-").toLowerCase()}`;
  }
  if (parsed.free && parsed.expiresAt) {
    return `free-through-${parsed.expiresAt}`;
  }
  if (parsed.free) return "free";
  if (parsed.discountPercent > 0) {
    return `${parsed.discountPercent}-percent-off`;
  }
  return parsed.dealId;
}

function normalizeExpires(raw: string | null): string | null {
  if (!raw) return null;
  // Page uses YYYY-MM-DD. A date-only expiry means "valid through this whole day", so we
  // store it as END-of-day Pacific-ish ISO (23:59:59) — a deal expiring "2026-08-02"
  // remains active for the entirety of August 2nd. (Previously this produced
  // T00:00:00, i.e. START of day, contradicting this same comment — an off-by-a-day
  // that made the deal expire a full day earlier than intended.)
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T23:59:59-07:00`;
  }
  return raw;
}

function normalizeStarts(raw: string | null): string | null {
  if (!raw) return null;
  // A date-only startsAt means "takes effect from the beginning of this day", so unlike
  // normalizeExpires above, date-only values are START-of-day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T00:00:00-07:00`;
  }
  return raw;
}

export function parseOfficialPricingHtml(html: string): ParsedOfficialPricing {
  const ratesById = new Map<string, ParsedOfficialRate>();

  for (const m of html.matchAll(RATE_RE)) {
    const pageId = m[1]!;
    const input = Number(m[2]);
    const output = Number(m[3]);
    const cacheRead = Number(m[4]);
    const cacheWrite = m[5] !== undefined ? Number(m[5]) : undefined;
    if (![input, output, cacheRead].every((n) => Number.isFinite(n) && n >= 0)) continue;
    if (cacheWrite !== undefined && (!Number.isFinite(cacheWrite) || cacheWrite < 0)) continue;

    // Capture provider/name when adjacent in the same object (best-effort)
    const windowStart = Math.max(0, m.index - 40);
    const windowEnd = Math.min(html.length, (m.index ?? 0) + m[0].length + 20);
    const win = html.slice(windowStart, windowEnd);
    const nameM = win.match(/\\?"name\\?":\\?"([^"\\]+)\\?"/);
    const provM = win.match(/\\?"provider\\?":\\?"([^"\\]+)\\?"/);
    const catM = win.match(/\\?"category\\?":\\?"([^"\\]+)\\?"/);

    ratesById.set(pageId, {
      pageId,
      name: nameM?.[1],
      provider: provM?.[1],
      category: catM?.[1],
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: cacheRead,
      ...(cacheWrite !== undefined ? { cacheWritePerMillion: cacheWrite } : {}),
    });
  }

  const dealsById = new Map<string, ParsedOfficialDeal>();
  for (const m of html.matchAll(DEAL_RE)) {
    const dealId = m[1]!;
    const discountPercent = Number(m[2]);
    const rest = m[3] ?? "";
    if (!Number.isFinite(discountPercent)) continue;
    const expM = rest.match(/expires\\?":\\?"([^"\\]+)/);
    const startsM = rest.match(/startsAt\\?":\\?"([^"\\]+)/);
    const endsM = rest.match(/endsWhen\\?":\\?"([^"\\]+)/);
    const freeM = rest.match(/free\\?":(true|false)/);
    const free = freeM ? freeM[1] === "true" : discountPercent >= 100;
    const expiresAt = normalizeExpires(expM?.[1] ?? null);
    const startsAt = normalizeStarts(startsM?.[1] ?? null);
    const endsWhen = endsM?.[1] ?? null;
    const pageModelId = dealIdToPageModelId(dealId);
    const usageMultiplier = usageMultiplierFromDealId(dealId);
    const label = dealLabel({ dealId, discountPercent, free, expiresAt, endsWhen });
    dealsById.set(dealId, {
      dealId,
      pageModelId,
      discountPercent,
      free,
      expiresAt,
      startsAt,
      endsWhen,
      label,
      ...(usageMultiplier !== undefined ? { usageMultiplier } : {}),
    });
  }

  // Free deal models often omit cost rows; synthesize zero rates so merge can apply
  for (const deal of dealsById.values()) {
    if (!deal.free) continue;
    if (ratesById.has(deal.pageModelId)) continue;
    ratesById.set(deal.pageModelId, {
      pageId: deal.pageModelId,
      inputPerMillion: 0,
      outputPerMillion: 0,
      cacheReadPerMillion: 0,
    });
  }

  return {
    rates: [...ratesById.values()],
    deals: [...dealsById.values()],
  };
}

/**
 * Map page model ids onto known snapshot/catalog ids.
 * Prefers exact match, then unique leaf match (segment after `/`).
 * Ambiguous leaves are not mapped (returns null for that page id).
 */
export function buildPageIdResolver(
  knownModelIds: Iterable<string>,
): (pageId: string) => string | null {
  const known = [...knownModelIds];
  const exact = new Set(known);
  const byLeaf = new Map<string, string[]>();
  for (const id of known) {
    const leaf = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    const list = byLeaf.get(leaf) ?? [];
    list.push(id);
    byLeaf.set(leaf, list);
  }

  return (pageId: string): string | null => {
    if (exact.has(pageId)) return pageId;
    const leaf = pageId.includes("/") ? pageId.slice(pageId.lastIndexOf("/") + 1) : pageId;
    const hits = byLeaf.get(leaf);
    if (hits && hits.length === 1) return hits[0]!;
    // also try matching when known leaf equals full pageId
    if (hits && hits.length > 1) return null;
    return null;
  };
}
