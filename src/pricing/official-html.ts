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
  endsWhen: string | null;
  label: string;
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
  // Page uses YYYY-MM-DD; store as end-of-day Pacific-ish ISO when date-only
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
    const endsM = rest.match(/endsWhen\\?":\\?"([^"\\]+)/);
    const freeM = rest.match(/free\\?":(true|false)/);
    const free = freeM ? freeM[1] === "true" : discountPercent >= 100;
    const expiresAt = normalizeExpires(expM?.[1] ?? null);
    const endsWhen = endsM?.[1] ?? null;
    const pageModelId = dealIdToPageModelId(dealId);
    const label = dealLabel({ dealId, discountPercent, free, expiresAt, endsWhen });
    dealsById.set(dealId, {
      dealId,
      pageModelId,
      discountPercent,
      free,
      expiresAt,
      endsWhen,
      label,
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
