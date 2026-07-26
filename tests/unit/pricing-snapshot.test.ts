import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelPricing } from "../../src/domain/model.js";
import { OFFICIAL_PRICING_SOURCE } from "../../src/pricing/official-source.js";
import { refreshDealsFromOfficial, refreshPricingFromOfficial } from "../../src/pricing/refresh.js";
import {
  DEFAULT_FRESHNESS_THRESHOLDS,
  PartialCommitError,
  commitPricingAndDeals,
  computeDealSourceHash,
  computePricingSourceHash,
  dealsSnapshotPath,
  evaluatePricingUsability,
  loadDealSnapshot,
  loadDealSnapshotChecked,
  loadPricingSnapshot,
  loadPricingSnapshotChecked,
  loadSeedDealSnapshot,
  loadSeedPricingSnapshot,
  pricingSnapshotPath,
  saveDealSnapshot,
  savePricingSnapshot,
  sha256,
  snapshotAgeMs,
} from "../../src/pricing/snapshot.js";

describe("pricing snapshot + refresh", () => {
  let dir: string;
  const prevHome = process.env.HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccroute-price-"));
    process.env.HOME = dir;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads seed when no snapshot file", () => {
    const p = loadPricingSnapshot();
    expect(p.models.length).toBeGreaterThan(0);
    const d = loadDealSnapshot();
    expect(d.deals.length).toBeGreaterThan(0);
  });

  it("saves and reloads pricing atomically", () => {
    const seed = loadPricingSnapshot();
    const next = { ...seed, retrievedAt: "2026-07-23T12:00:00.000Z", sourceHash: sha256("x") };
    savePricingSnapshot(next);
    const loaded = loadPricingSnapshot();
    expect(loaded.retrievedAt).toBe("2026-07-23T12:00:00.000Z");
  });

  it("saves deals", () => {
    const seed = loadSeedDealSnapshot();
    saveDealSnapshot({ ...seed, retrievedAt: "2026-07-23T13:00:00.000Z" });
    expect(loadDealSnapshot().retrievedAt).toBe("2026-07-23T13:00:00.000Z");
  });

  it("refresh preserves on network failure", async () => {
    const r = await refreshPricingFromOfficial({
      allowNetwork: true,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.preservedPrior).toBe(true);
  });

  it("refresh deals network failure preserves", async () => {
    const r = await refreshDealsFromOfficial({
      allowNetwork: true,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.preservedPrior).toBe(true);
  });

  it("refresh offline seed path succeeds", async () => {
    const r = await refreshPricingFromOfficial({ allowNetwork: false });
    expect(r.ok).toBe(true);
    const d = await refreshDealsFromOfficial({ allowNetwork: false });
    expect(d.ok).toBe(true);
  });

  it("snapshotAgeMs", () => {
    expect(snapshotAgeMs("2026-07-23T00:00:00.000Z", Date.parse("2026-07-23T01:00:00.000Z"))).toBe(
      3600_000,
    );
    expect(snapshotAgeMs("bad", 0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("official source constant", () => {
    expect(OFFICIAL_PRICING_SOURCE).toContain("commandcode.ai");
  });

  // ── Defect 1: sourceHash must be verified on load, not just written ──

  it("write path always computes a correct sourceHash regardless of what the caller supplied", () => {
    const seed = loadPricingSnapshot();
    // Caller supplies a bogus hash (as the old cli.ts `models refresh` command effectively
    // does with its `models-${n}-${timestamp}` placeholder) — savePricingSnapshot must not
    // trust it.
    savePricingSnapshot({ ...seed, sourceHash: "totally-bogus-not-a-hash" });
    const onDisk = loadPricingSnapshot();
    expect(onDisk.sourceHash).toBe(computePricingSourceHash(onDisk.models));
    expect(onDisk.sourceHash).not.toBe("totally-bogus-not-a-hash");
  });

  it("detects a schema-valid but tampered pricing snapshot and fails closed to the seed", () => {
    const seed = loadPricingSnapshot();
    savePricingSnapshot(seed); // write a genuinely correct file first
    // Now hand-tamper it on disk: bump a rate but leave the (now-stale) sourceHash alone.
    // This is schema-valid JSON — the whole point of the defect is that a plain
    // safeParse() can't catch this.
    const onDiskRaw = JSON.parse(readFileSync(pricingSnapshotPath(), "utf8"));
    onDiskRaw.models[0].inputPerMillion = 999;
    writeFileSync(pricingSnapshotPath(), JSON.stringify(onDiskRaw, null, 2));

    const checked = loadPricingSnapshotChecked();
    expect(checked.verified).toBe(false);
    expect(checked.reason).toMatch(/sourceHash/i);
    // Fail closed: the tampered rate must NOT be trusted — we fall back to the seed.
    expect(
      checked.snapshot.models.find((m) => m.id === onDiskRaw.models[0].id)?.inputPerMillion,
    ).not.toBe(999);
    // The convenience wrapper returns the same fail-closed snapshot.
    expect(
      loadPricingSnapshot().models.find((m) => m.id === onDiskRaw.models[0].id)?.inputPerMillion,
    ).not.toBe(999);
  });

  it("detects a schema-valid but tampered deal snapshot and fails closed to the seed", () => {
    const seed = loadDealSnapshot();
    saveDealSnapshot(seed);
    const onDiskRaw = JSON.parse(readFileSync(dealsSnapshotPath(), "utf8"));
    onDiskRaw.deals[0].label = "hand-edited-label";
    writeFileSync(dealsSnapshotPath(), JSON.stringify(onDiskRaw, null, 2));

    const checked = loadDealSnapshotChecked();
    expect(checked.verified).toBe(false);
    expect(checked.snapshot.deals.some((d) => d.label === "hand-edited-label")).toBe(false);
  });

  it("a corrupt/unparsable file (not a tamper signal) falls back to seed as verified", () => {
    mkdirSync(pricingSnapshotPath().replace(/[^/]+$/, ""), { recursive: true });
    writeFileSync(pricingSnapshotPath(), "not valid json");
    const checked = loadPricingSnapshotChecked();
    expect(checked.verified).toBe(true);
    expect(checked.snapshot.models.length).toBeGreaterThan(0);
  });

  it("seed sourceHash matches its own content (regenerated real digest, not a decorative sentinel)", () => {
    const seed = loadSeedPricingSnapshot();
    expect(seed.sourceHash).toBe(computePricingSourceHash(seed.models));
    expect(seed.sourceHash).not.toBe("seed-2026-07-23");
    const deals = loadSeedDealSnapshot();
    expect(deals.sourceHash).toBe(computeDealSourceHash(deals.deals));
    expect(deals.sourceHash).not.toBe("seed-deals-2026-07-23");
  });

  // ── Defect 7: two-file commit must be staged, and partial failure reported accurately ──

  it("commitPricingAndDeals surfaces PartialCommitError instead of silently succeeding when the deals rename fails", () => {
    const pricing = loadSeedPricingSnapshot();
    const deals = loadSeedDealSnapshot();
    // Make the deals snapshot's own path an existing directory so its rename step fails,
    // while the pricing path remains free to succeed — a controlled partial-commit.
    mkdirSync(dealsSnapshotPath(), { recursive: true });
    expect(() => commitPricingAndDeals(pricing, deals)).toThrow(PartialCommitError);
    // Pricing WAS committed even though the overall call threw — this is exactly the
    // state a caller must not describe as "prior preserved".
    expect(loadPricingSnapshot().sourceHash).toBe(computePricingSourceHash(pricing.models));
  });

  // ── Defect 5: §15 staleness thresholds must be enforced, not just computed ──

  const modelWithDeal: ModelPricing = {
    id: "has/deal",
    contextWindow: 1000,
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: 0,
    priceBasis: "post_discount",
    qualityTier: "economical",
    availability: "available",
    deal: { type: "free", label: "x", expiresAt: null },
  };
  const modelNoDeal: ModelPricing = {
    id: "no/deal",
    contextWindow: 1000,
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: 0,
    priceBasis: "current_rate",
    qualityTier: "economical",
    availability: "available",
  };

  it("fresh and acceptable snapshots are always usable regardless of deals", () => {
    const now = new Date("2026-07-26T12:00:00Z");
    const fresh = evaluatePricingUsability({
      model: modelWithDeal,
      retrievedAt: "2026-07-26T00:00:00Z", // 12h old
      now,
    });
    expect(fresh.freshness).toBe("fresh");
    expect(fresh.usable).toBe(true);

    const acceptable = evaluatePricingUsability({
      model: modelWithDeal,
      retrievedAt: "2026-07-25T00:00:00Z", // 36h old
      now,
    });
    expect(acceptable.freshness).toBe("acceptable");
    expect(acceptable.usable).toBe(true);
  });

  it("a stale snapshot is unusable for a model with a deal, but usable for one without", () => {
    const now = new Date("2026-07-26T12:00:00Z");
    const retrievedAt = "2026-07-20T00:00:00Z"; // >72h old
    const staleWithDeal = evaluatePricingUsability({ model: modelWithDeal, retrievedAt, now });
    expect(staleWithDeal.freshness).toBe("stale");
    expect(staleWithDeal.dealAffectsModel).toBe(true);
    expect(staleWithDeal.usable).toBe(false);

    const staleNoDeal = evaluatePricingUsability({ model: modelNoDeal, retrievedAt, now });
    expect(staleNoDeal.freshness).toBe("stale");
    expect(staleNoDeal.dealAffectsModel).toBe(false);
    expect(staleNoDeal.usable).toBe(true);
  });

  it("a temporary_introductory_rate model counts as deal-affected for staleness purposes", () => {
    const now = new Date("2026-07-26T12:00:00Z");
    const introModel: ModelPricing = { ...modelNoDeal, priceBasis: "temporary_introductory_rate" };
    const result = evaluatePricingUsability({
      model: introModel,
      retrievedAt: "2026-07-20T00:00:00Z",
      now,
    });
    expect(result.dealAffectsModel).toBe(true);
    expect(result.usable).toBe(false);
  });

  it("freshness thresholds are configurable", () => {
    const now = new Date("2026-07-26T12:00:00Z");
    const result = evaluatePricingUsability({
      model: modelNoDeal,
      retrievedAt: "2026-07-26T11:00:00Z", // 1h old
      now,
      thresholds: { freshMaxAgeMs: 30 * 60 * 1000, acceptableMaxAgeMs: 45 * 60 * 1000 },
    });
    expect(result.freshness).toBe("stale");
    expect(DEFAULT_FRESHNESS_THRESHOLDS.freshMaxAgeMs).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_FRESHNESS_THRESHOLDS.acceptableMaxAgeMs).toBe(72 * 60 * 60 * 1000);
  });
});
