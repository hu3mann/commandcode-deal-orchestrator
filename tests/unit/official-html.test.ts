import { mkdirSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { mergeOfficialIntoSnapshots } from "../../src/pricing/merge-official.js";
import {
  type ParsedOfficialPricing,
  buildPageIdResolver,
  dealIdToPageModelId,
  parseOfficialPricingHtml,
} from "../../src/pricing/official-html.js";
import { refreshPricingFromOfficial } from "../../src/pricing/refresh.js";
import {
  dealsSnapshotPath,
  loadDealSnapshot,
  loadPricingSnapshot,
  loadSeedDealSnapshot,
  loadSeedPricingSnapshot,
  saveDealSnapshot,
  savePricingSnapshot,
} from "../../src/pricing/snapshot.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/pricing-limits-sample.html",
);

describe("official HTML pricing parse", () => {
  it("dealIdToPageModelId strips deal suffixes", () => {
    expect(dealIdToPageModelId("deepseek-v4-pro-4x-usage")).toBe("deepseek-v4-pro");
    expect(dealIdToPageModelId("mimo-v2.5-98-off")).toBe("mimo-v2.5");
    expect(dealIdToPageModelId("mimo-v2.5-pro-99-off")).toBe("mimo-v2.5-pro");
    expect(dealIdToPageModelId("laguna-s-2.1-free")).toBe("laguna-s-2.1-free");
  });

  it("parses rates and deals from fixture HTML", () => {
    const html = readFileSync(fixturePath, "utf8");
    const parsed = parseOfficialPricingHtml(html);
    expect(parsed.rates.length).toBeGreaterThanOrEqual(6);
    const flash = parsed.rates.find((r) => r.pageId === "deepseek-v4-flash");
    expect(flash?.inputPerMillion).toBe(0.14);
    expect(flash?.outputPerMillion).toBe(0.28);
    const sonnet = parsed.rates.find((r) => r.pageId === "claude-sonnet-5");
    expect(sonnet?.cacheWritePerMillion).toBe(2.5);
    expect(parsed.deals.some((d) => d.pageModelId === "deepseek-v4-pro")).toBe(true);
    expect(parsed.deals.some((d) => d.free && d.pageModelId === "laguna-s-2.1-free")).toBe(true);
    const ling = parsed.deals.find((d) => d.pageModelId === "ling-3.0-flash-free");
    expect(ling?.expiresAt).toContain("2026-08-02");
  });

  it("resolves page ids onto known snapshot ids", () => {
    const resolve = buildPageIdResolver([
      "deepseek/deepseek-v4-flash",
      "xiaomi/mimo-v2.5",
      "tencent/hy3-paid",
    ]);
    expect(resolve("deepseek-v4-flash")).toBe("deepseek/deepseek-v4-flash");
    expect(resolve("mimo-v2.5")).toBe("xiaomi/mimo-v2.5");
    expect(resolve("tencent/hy3-paid")).toBe("tencent/hy3-paid");
    expect(resolve("totally-unknown-model")).toBeNull();
  });
});

describe("merge official into snapshots", () => {
  it("updates known models only and never invents ids", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const html = readFileSync(fixturePath, "utf8");
    const parsed = parseOfficialPricingHtml(html);
    // Inject an unknown rate
    parsed.rates.push({
      pageId: "invented-never-existed",
      inputPerMillion: 0.01,
      outputPerMillion: 0.02,
      cacheReadPerMillion: 0,
    });
    const beforeIds = new Set(basePricing.models.map((m) => m.id));
    const merged = mergeOfficialIntoSnapshots({
      basePricing,
      baseDeals,
      parsed,
      now: new Date("2026-07-26T00:00:00Z"),
    });
    expect(merged.pricing.models.every((m) => beforeIds.has(m.id))).toBe(true);
    expect(merged.unmappedPageIds).toContain("invented-never-existed");
    expect(merged.updatedModelIds).toContain("deepseek/deepseek-v4-pro");
    const pro = merged.pricing.models.find((m) => m.id === "deepseek/deepseek-v4-pro");
    expect(pro?.inputPerMillion).toBe(0.435);
    expect(pro?.deal?.type).toBe("permanent_price_reduction");
    expect(pro?.priceBasis).toBe("post_discount");
    const laguna = merged.pricing.models.find((m) => m.id === "poolside/laguna-s-2.1-free");
    expect(laguna?.inputPerMillion).toBe(0);
    expect(laguna?.deal?.type).toBe("free");
    expect(laguna?.deal?.capacityLimited).toBe(true);
  });

  // ── Defect 4: a deal with a future (still-active) expiresAt must classify as
  // temporary_rate, not permanent_price_reduction. The inverted logic used to do the
  // opposite: only an *already expired* deal got "temporary_rate". This also exercises
  // the tier-rewrite block (merge-official.ts) and the temporary_rate applyRate branch,
  // both previously uncovered. ──

  it("classifies a still-active, time-bound deal as temporary_rate (defect 4 fix) and rewrites tier rates", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const now = new Date("2026-07-26T00:00:00Z");
    // minimaxai/minimax-m3 has a `tiers` array in the seed, so this also exercises the
    // tier-rewrite block in applyRate().
    const parsed: ParsedOfficialPricing = {
      rates: [
        {
          pageId: "minimax-m3",
          inputPerMillion: 0.2,
          outputPerMillion: 0.8,
          cacheReadPerMillion: 0.04,
          cacheWritePerMillion: 0.05,
        },
      ],
      deals: [
        {
          dealId: "minimax-m3-limited-time",
          pageModelId: "minimax-m3",
          discountPercent: 33,
          free: false,
          expiresAt: "2026-12-31T23:59:59-07:00", // in the future relative to `now`
          startsAt: null,
          endsWhen: null,
          label: "limited-time-discount",
        },
      ],
    };
    const merged = mergeOfficialIntoSnapshots({ basePricing, baseDeals, parsed, now });
    const m3 = merged.pricing.models.find((m) => m.id === "minimaxai/minimax-m3");
    // Defect 4: a deal that is still active and has an end date is temporary, not
    // permanent — the opposite of the old (inverted) behavior.
    expect(m3?.deal?.type).toBe("temporary_rate");
    expect(m3?.inputPerMillion).toBe(0.2);
    expect(m3?.outputPerMillion).toBe(0.8);
    // tier-rewrite: every tier must be rewritten to the new flat rate, not left stale.
    expect(m3?.tiers?.length).toBeGreaterThan(0);
    for (const t of m3?.tiers ?? []) {
      expect(t.inputPerMillion).toBe(0.2);
      expect(t.outputPerMillion).toBe(0.8);
      expect(t.cacheReadPerMillion).toBe(0.04);
      expect(t.cacheWritePerMillion).toBe(0.05);
    }
  });

  it("applies an active free deal via the free-deal-only merge path when no rate row exists", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const now = new Date("2026-07-26T00:00:00Z");
    const parsed: ParsedOfficialPricing = {
      rates: [], // no rate row synthesized for this deal (unlike official-html.ts's own
      // free-deal synthesis) — exercises merge-official.ts's own free-deal-only path.
      deals: [
        {
          dealId: "grok-4.5-free",
          pageModelId: "grok-4.5",
          discountPercent: 100,
          free: true,
          expiresAt: null,
          startsAt: null,
          endsWhen: null,
          label: "free",
        },
      ],
    };
    const merged = mergeOfficialIntoSnapshots({ basePricing, baseDeals, parsed, now });
    const grok = merged.pricing.models.find((m) => m.id === "xai/grok-4.5");
    expect(grok?.inputPerMillion).toBe(0);
    expect(grok?.outputPerMillion).toBe(0);
    expect(grok?.deal?.type).toBe("free");
    expect(grok?.priceBasis).toBe("post_discount");
    expect(merged.updatedModelIds).toContain("xai/grok-4.5");
  });

  it("tier-rewrite leaves cacheWritePerMillion alone when the official rate row omits it", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const now = new Date("2026-07-26T00:00:00Z");
    const parsed: ParsedOfficialPricing = {
      rates: [
        {
          pageId: "minimax-m3",
          inputPerMillion: 0.25,
          outputPerMillion: 1,
          cacheReadPerMillion: 0.05,
          // no cacheWritePerMillion in this rate row
        },
      ],
      deals: [],
    };
    const merged = mergeOfficialIntoSnapshots({ basePricing, baseDeals, parsed, now });
    const m3 = merged.pricing.models.find((m) => m.id === "minimaxai/minimax-m3");
    for (const t of m3?.tiers ?? []) {
      expect(t.inputPerMillion).toBe(0.25);
      expect(t.cacheWritePerMillion).toBeUndefined();
    }
  });

  it("classifies a deal with no expiresAt as permanent_rate", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const now = new Date("2026-07-26T00:00:00Z");
    const parsed: ParsedOfficialPricing = {
      rates: [
        {
          pageId: "hy3-paid",
          inputPerMillion: 0.1,
          outputPerMillion: 0.4,
          cacheReadPerMillion: 0.02,
        },
      ],
      deals: [
        {
          dealId: "hy3-paid-forever",
          pageModelId: "hy3-paid",
          discountPercent: 30,
          free: false,
          expiresAt: null,
          startsAt: null,
          endsWhen: null,
          label: "forever-discount",
        },
      ],
    };
    const merged = mergeOfficialIntoSnapshots({ basePricing, baseDeals, parsed, now });
    const hy3 = merged.pricing.models.find((m) => m.id === "tencent/hy3-paid");
    expect(hy3?.deal?.type).toBe("permanent_price_reduction");
    expect(hy3?.deal?.kind).toBe("permanent_rate");
  });

  // ── §14 startsAt gate at merge time: a deal must not be applied before it begins ──

  it("does not apply a deal whose startsAt is in the future during merge (main rate-row path)", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const now = new Date("2026-07-26T00:00:00Z");
    const original = basePricing.models.find((m) => m.id === "tencent/hy3-paid")!;
    const parsed: ParsedOfficialPricing = {
      rates: [
        {
          pageId: "hy3-paid",
          inputPerMillion: original.inputPerMillion!,
          outputPerMillion: original.outputPerMillion!,
          cacheReadPerMillion: original.cacheReadPerMillion!,
        },
      ],
      deals: [
        {
          dealId: "hy3-paid-future-free",
          pageModelId: "hy3-paid",
          discountPercent: 100,
          free: true,
          expiresAt: null,
          startsAt: "2099-01-01T00:00:00-07:00",
          endsWhen: null,
          label: "future-free",
        },
      ],
    };
    const merged = mergeOfficialIntoSnapshots({ basePricing, baseDeals, parsed, now });
    const hy3 = merged.pricing.models.find((m) => m.id === "tencent/hy3-paid");
    // Recorded for visibility (e.g. `ccroute deals list`) but must NOT be applied yet.
    expect(hy3?.deal?.startsAt).toBe("2099-01-01T00:00:00-07:00");
    expect(hy3?.inputPerMillion).toBe(original.inputPerMillion);
    expect(hy3?.priceBasis).toBe("current_rate");
  });

  it("does not zero out a model's rate for a pending free deal with no rate row (free-deal-only merge path)", () => {
    const basePricing = loadSeedPricingSnapshot();
    const baseDeals = loadSeedDealSnapshot();
    const now = new Date("2026-07-26T00:00:00Z");
    const grok = basePricing.models.find((m) => m.id === "xai/grok-4.5")!;
    const parsed: ParsedOfficialPricing = {
      rates: [],
      deals: [
        {
          dealId: "grok-4.5-future-free",
          pageModelId: "grok-4.5",
          discountPercent: 100,
          free: true,
          expiresAt: null,
          startsAt: "2099-01-01T00:00:00-07:00",
          endsWhen: null,
          label: "future-free",
        },
      ],
    };
    const merged = mergeOfficialIntoSnapshots({ basePricing, baseDeals, parsed, now });
    const updatedGrok = merged.pricing.models.find((m) => m.id === "xai/grok-4.5");
    expect(updatedGrok?.inputPerMillion).toBe(grok.inputPerMillion);
    expect(merged.updatedModelIds).not.toContain("xai/grok-4.5");
  });
});

describe("network refresh merge", () => {
  let dir: string;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-net-refresh-"));
    process.env.HOME = dir;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refresh --network parses HTML and updates snapshot", async () => {
    const html = readFileSync(fixturePath, "utf8");
    // Seed prior snapshot first
    savePricingSnapshot(loadSeedPricingSnapshot());
    saveDealSnapshot(loadSeedDealSnapshot());

    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () => html,
        }) as Response,
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("official-html");
    expect(r.updatedModelIds?.length).toBeGreaterThan(0);
    const snap = loadPricingSnapshot();
    expect(snap.source).toContain("commandcode.ai");
    expect(snap.models.find((m) => m.id === "deepseek/deepseek-v4-flash")?.inputPerMillion).toBe(
      0.14,
    );
    const deals = loadDealSnapshot();
    expect(deals.deals.some((d) => d.modelId === "deepseek/deepseek-v4-pro")).toBe(true);
  });

  it("refresh --network preserves prior when HTML has no rates", async () => {
    // Note: savePricingSnapshot always recomputes sourceHash from `models` (defect fix:
    // sourceHash must never be a caller-supplied, unverified value), so a hand-picked
    // marker string like the old "prior-marker" would just get silently overwritten with
    // a real hash here. We instead pin `retrievedAt` to a distinguishable value to prove
    // the prior snapshot was genuinely left untouched by the failed refresh below.
    const prior = {
      ...loadSeedPricingSnapshot(),
      retrievedAt: "2026-01-01T00:00:00.000Z",
    };
    savePricingSnapshot(prior);
    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          text: async () => "<html><body>no rates here</body></html>",
        }) as Response,
    });
    expect(r.ok).toBe(false);
    expect(r.preservedPrior).toBe(true);
    expect(loadPricingSnapshot().retrievedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  // ── Defect 6: content-type must be validated, not just HTTP status ──

  it("refresh --network rejects a 200 response whose content-type is not HTML", async () => {
    const prior = { ...loadSeedPricingSnapshot(), retrievedAt: "2026-02-02T00:00:00.000Z" };
    savePricingSnapshot(prior);
    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          // A WAF/maintenance page or JSON error body served with a 200 status; content
          // exceeds 100 bytes and could otherwise slip past the old checks.
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          text: async () => `{"ok":false,"reason":"maintenance"}${"x".repeat(200)}`,
        }) as unknown as Response,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/content-type/i);
    expect(r.preservedPrior).toBe(true);
    expect(loadPricingSnapshot().retrievedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("refresh --network still accepts a response with no headers at all (legitimate test mocks)", async () => {
    // Mocks that don't bother setting headers (as used throughout this file and in
    // branch-coverage.test.ts, which this suite must not break) must keep working: the
    // content-type check only rejects a header that is present and explicitly non-HTML.
    const html = readFileSync(fixturePath, "utf8");
    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) as Response,
    });
    expect(r.ok).toBe(true);
  });

  // ── Defect 7: a partial two-file commit must not be reported as preservedPrior ──

  it("reports preservedPrior:false (not true) when the deals half of the commit fails", async () => {
    const html = readFileSync(fixturePath, "utf8");
    savePricingSnapshot(loadSeedPricingSnapshot());
    saveDealSnapshot(loadSeedDealSnapshot());
    // Force the deals rename step to fail by making its target path an existing
    // directory (a file can never be renamed onto a directory), while leaving the
    // pricing path free to succeed normally — simulating a partial commit.
    rmSync(dealsSnapshotPath(), { force: true });
    mkdirSync(dealsSnapshotPath(), { recursive: true });

    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) as Response,
    });
    expect(r.ok).toBe(false);
    // The old bug: this used to be reported as `true` even though pricing had already
    // been replaced by the time the deals commit failed.
    expect(r.preservedPrior).toBe(false);
    // Confirm pricing really was replaced (not preserved).
    const snap = loadPricingSnapshot();
    expect(snap.models.find((m) => m.id === "deepseek/deepseek-v4-flash")?.inputPerMillion).toBe(
      0.14,
    );
  });
});
