import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { afterEach, beforeEach } from "vitest";
import { mergeOfficialIntoSnapshots } from "../../src/pricing/merge-official.js";
import {
  buildPageIdResolver,
  dealIdToPageModelId,
  parseOfficialPricingHtml,
} from "../../src/pricing/official-html.js";
import { refreshPricingFromOfficial } from "../../src/pricing/refresh.js";
import {
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
    const prior = {
      ...loadSeedPricingSnapshot(),
      retrievedAt: "2026-01-01T00:00:00.000Z",
      sourceHash: "prior-marker",
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
    expect(loadPricingSnapshot().sourceHash).toBe("prior-marker");
  });
});
