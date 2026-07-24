import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_PRICING_SOURCE } from "../../src/pricing/official-source.js";
import { refreshDealsFromOfficial, refreshPricingFromOfficial } from "../../src/pricing/refresh.js";
import {
  loadDealSnapshot,
  loadPricingSnapshot,
  loadSeedDealSnapshot,
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
});
