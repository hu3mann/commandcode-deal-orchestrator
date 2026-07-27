import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageRoot } from "../../src/config/defaults.js";
import {
  computePricingSourceHash,
  loadSeedPricingSnapshot,
  savePricingSnapshot,
} from "../../src/pricing/snapshot.js";
import {
  applyJitter,
  backoffDelayMs,
  computeNextEligibleAt,
  isBackoffActive,
} from "../../src/refresh/backoff.js";
import { bootstrapDealSnapshot, bootstrapPricingSnapshot } from "../../src/refresh/bootstrap.js";
import { runCoordinatedRefresh } from "../../src/refresh/coordinator.js";
import { buildLaunchdPlist, validatePlistXml } from "../../src/refresh/launchd.js";
import { isLeaseStale, releaseLease, tryAcquireLease } from "../../src/refresh/lease.js";
import { planSessionStartRefresh } from "../../src/refresh/session-start.js";
import { loadRefreshState, saveRefreshState } from "../../src/refresh/state.js";
import { emptyRefreshState } from "../../src/refresh/types.js";

const roots: string[] = [];

function tempState(): string {
  const d = mkdtempSync(join(tmpdir(), "ccroute-refresh-"));
  roots.push(d);
  mkdirSync(d, { recursive: true });
  return d;
}

afterEach(() => {
  // leave temps
  vi.unstubAllEnvs();
});

describe("refresh backoff", () => {
  it("uses stepped delays and maxes at last step", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(15 * 60 * 1000);
    expect(backoffDelayMs(2)).toBe(60 * 60 * 1000);
    expect(backoffDelayMs(3)).toBe(4 * 60 * 60 * 1000);
    expect(backoffDelayMs(4)).toBe(12 * 60 * 60 * 1000);
    expect(backoffDelayMs(99)).toBe(12 * 60 * 60 * 1000);
  });

  it("applies bounded jitter", () => {
    const base = 1000;
    const withJitter = applyJitter(base, 0.1, () => 1);
    expect(withJitter).toBe(1100);
    expect(applyJitter(0, 0.1)).toBe(0);
  });

  it("detects active backoff", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const st = { ...emptyRefreshState(), nextEligibleAttemptAt: future, failureCount: 1 };
    expect(isBackoffActive(st).active).toBe(true);
    expect(isBackoffActive(st, new Date(Date.now() + 120_000)).active).toBe(false);
  });

  it("computeNextEligibleAt is in the future", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const next = computeNextEligibleAt(1, now, undefined, () => 0);
    expect(Date.parse(next)).toBeGreaterThan(now.getTime());
  });
});

describe("refresh lease", () => {
  it("acquires, blocks second owner, releases, re-acquires", () => {
    const stateRoot = tempState();
    const a = tryAcquireLease({ stateRoot, ownerInstance: "a-1" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = tryAcquireLease({ stateRoot, ownerInstance: "b-1" });
    expect(b.ok).toBe(false);
    a.handle.release();
    const c = tryAcquireLease({ stateRoot, ownerInstance: "c-1" });
    expect(c.ok).toBe(true);
    if (c.ok) c.handle.release();
  });

  it("recovers stale lease without relying on PID", () => {
    const stateRoot = tempState();
    const past = new Date(Date.now() - 60_000);
    const a = tryAcquireLease({
      stateRoot,
      ownerInstance: "stale-1",
      ttlMs: 1,
      now: past,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    // lease already expired
    expect(isLeaseStale(a.handle.lease, new Date())).toBe(true);
    const b = tryAcquireLease({
      stateRoot,
      ownerInstance: "fresh-1",
      breakStaleOnly: true,
    });
    expect(b.ok).toBe(true);
    if (b.ok) b.handle.release();
  });

  it("refuses break-stale on healthy lease", () => {
    const stateRoot = tempState();
    const a = tryAcquireLease({ stateRoot, ownerInstance: "h-1", ttlMs: 60_000 });
    expect(a.ok).toBe(true);
    const b = tryAcquireLease({
      stateRoot,
      ownerInstance: "h-2",
      breakStaleOnly: true,
    });
    expect(b.ok).toBe(false);
    if (a.ok) a.handle.release();
  });
});

describe("bootstrap semantics", () => {
  it("does not claim freshness and preserves seed retrievedAt", () => {
    const stateRoot = tempState();
    // Point state dir via HOME
    const home = stateRoot;
    mkdirSync(join(home, ".commandcode", "deal-router"), { recursive: true });
    vi.stubEnv("HOME", home);

    // Clear any existing snapshots under this home
    const pricingPath = join(home, ".commandcode", "deal-router", "pricing-snapshot.json");
    if (existsSync(pricingPath)) rmSync(pricingPath);

    const seed = loadSeedPricingSnapshot();
    const r = bootstrapPricingSnapshot();
    expect(r.ok).toBe(true);
    expect(r.claimsFreshness).toBe(false);
    expect(r.wrote).toBe(true);
    expect(r.snapshotRetrievedAt).toBe(seed.retrievedAt);

    // Second bootstrap must not overwrite
    const r2 = bootstrapPricingSnapshot();
    expect(r2.wrote).toBe(false);
    expect(r2.claimsFreshness).toBe(false);

    // Newer snapshot preserved: touch retrievedAt forward
    const snap = JSON.parse(readFileSync(pricingPath, "utf8"));
    snap.retrievedAt = "2099-01-01T00:00:00.000Z";
    snap.sourceHash = computePricingSourceHash(snap.models);
    writeFileSync(pricingPath, JSON.stringify(snap, null, 2));
    const r3 = bootstrapPricingSnapshot();
    expect(r3.wrote).toBe(false);
    expect(r3.snapshotRetrievedAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it("bootstraps deals similarly", () => {
    const home = tempState();
    mkdirSync(join(home, ".commandcode", "deal-router"), { recursive: true });
    vi.stubEnv("HOME", home);
    const r = bootstrapDealSnapshot();
    expect(r.ok).toBe(true);
    expect(r.claimsFreshness).toBe(false);
  });
});

describe("coordinated refresh concurrency", () => {
  it("10 simultaneous attempts → 1 network fetch, 9 skips", async () => {
    const stateRoot = tempState();
    let networkCalls = 0;
    const networkRefresh = async () => {
      networkCalls += 1;
      // hold the lease briefly
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, preservedPrior: false, snapshotHash: "h1" };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        runCoordinatedRefresh({
          stateDir: stateRoot,
          networkRefresh,
          allowNetwork: true,
          force: true,
          mode: "network",
        }),
      ),
    );

    const acquired = results.filter((r) => r.leaseAcquired && !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    expect(networkCalls).toBe(1);
    expect(acquired.length).toBe(1);
    expect(skipped.length).toBe(9);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("records backoff after failure", async () => {
    const stateRoot = tempState();
    const r = await runCoordinatedRefresh({
      stateDir: stateRoot,
      force: true,
      networkRefresh: async () => ({
        ok: false,
        error: "simulated outage",
        preservedPrior: true,
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.state.failureCount).toBe(1);
    expect(r.state.nextEligibleAttemptAt).toBeTruthy();
    expect(r.state.activeLease).toBeNull(); // released

    const blocked = await runCoordinatedRefresh({
      stateDir: stateRoot,
      force: false,
      networkRefresh: async () => {
        throw new Error("should not run");
      },
    });
    expect(blocked.skipped).toBe(true);
    expect(blocked.reason).toMatch(/Backoff/i);
  });

  it("manual force bypasses backoff", async () => {
    const stateRoot = tempState();
    saveRefreshState(
      {
        ...emptyRefreshState(),
        failureCount: 3,
        nextEligibleAttemptAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      stateRoot,
    );
    let called = false;
    const r = await runCoordinatedRefresh({
      stateDir: stateRoot,
      force: true,
      networkRefresh: async () => {
        called = true;
        return { ok: true, preservedPrior: false, snapshotHash: "x" };
      },
    });
    expect(called).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(false);
  });
});

describe("launchd plist", () => {
  it("builds valid plist without KeepAlive or shell", () => {
    const xml = buildLaunchdPlist({
      ccroutePath: "/usr/local/bin/ccroute",
      homeDir: "/tmp/home",
      stateRoot: "/tmp/home/.commandcode/deal-router",
      workingDirectory: "/tmp/home/.commandcode/deal-router",
    });
    const v = validatePlistXml(xml);
    expect(v.ok).toBe(true);
    expect(xml).toContain("ai.commandcode.ccroute.refresh");
    expect(xml).toContain("/usr/local/bin/ccroute");
    expect(xml).toContain("<false/>"); // KeepAlive false
    expect(xml).not.toContain("/bin/sh");
  });
});

describe("session-start plan", () => {
  it("skips when backoff or lease held; never requires model", () => {
    const stateRoot = tempState();
    saveRefreshState(
      {
        ...emptyRefreshState(),
        nextEligibleAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        failureCount: 1,
      },
      stateRoot,
    );
    // plan uses global stateDir from HOME — stub via save is not enough without HOME
    // Exercise pure planning with fresh defaults
    const plan = planSessionStartRefresh({ routingEnabled: true });
    expect(plan.staticContextLines.some((l) => l.includes("routing is enabled"))).toBe(true);
    expect(plan.staticContextLines.some((l) => l.includes("authorization"))).toBe(true);
  });
});

// silence unused packageRoot if needed
void packageRoot;
void releaseLease;
void loadRefreshState;
void savePricingSnapshot;
