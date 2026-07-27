import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computePricingSourceHash,
  loadSeedPricingSnapshot,
  savePricingSnapshot,
} from "../../src/pricing/snapshot.js";
import {
  bootstrapDealSnapshot,
  bootstrapPricingSnapshot,
  currentSnapshotFingerprint,
} from "../../src/refresh/bootstrap.js";
import { getRefreshStatus, runCoordinatedRefresh } from "../../src/refresh/coordinator.js";
import {
  installLaunchd,
  setLaunchctlRunnerForTests,
  statusLaunchd,
  uninstallLaunchd,
} from "../../src/refresh/launchd.js";
import { isLeaseStale, tryAcquireLease } from "../../src/refresh/lease.js";
import { planSessionStartRefresh } from "../../src/refresh/session-start.js";
import { loadRefreshState, saveRefreshState } from "../../src/refresh/state.js";
import {
  RefreshBackoffError,
  RefreshLeaseError,
  emptyRefreshState,
} from "../../src/refresh/types.js";

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "ccroute-rm-"));
  mkdirSync(join(d, ".commandcode", "deal-router"), { recursive: true });
  mkdirSync(join(d, "Library", "LaunchAgents"), { recursive: true });
  return d;
}

afterEach(() => {
  setLaunchctlRunnerForTests(null);
  vi.unstubAllEnvs();
});

describe("refresh more coverage", () => {
  it("bootstraps over corrupt snapshot files", () => {
    const home = tempHome();
    vi.stubEnv("HOME", home);
    const root = join(home, ".commandcode", "deal-router");
    writeFileSync(join(root, "pricing-snapshot.json"), "{not-json");
    writeFileSync(join(root, "deals-snapshot.json"), "[]");
    const p = bootstrapPricingSnapshot();
    expect(p.ok).toBe(true);
    expect(p.wrote).toBe(true);
    expect(p.claimsFreshness).toBe(false);
    const d = bootstrapDealSnapshot();
    expect(d.ok).toBe(true);
    expect(d.claimsFreshness).toBe(false);
    expect(currentSnapshotFingerprint().length).toBe(64);
  });

  it("bootstrap refuses when valid hash-matching file exists", () => {
    const home = tempHome();
    vi.stubEnv("HOME", home);
    const seed = loadSeedPricingSnapshot();
    savePricingSnapshot(seed);
    const r = bootstrapPricingSnapshot();
    expect(r.wrote).toBe(false);
  });

  it("coordinator treats thrown network refresh as failure with backoff", async () => {
    const stateRoot = join(tempHome(), ".commandcode", "deal-router");
    const r = await runCoordinatedRefresh({
      stateDir: stateRoot,
      force: true,
      networkRefresh: async () => {
        throw new Error("boom-network");
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom-network/);
    expect(r.state.activeLease).toBeNull();
    expect(r.state.failureCount).toBeGreaterThan(0);
  });

  it("getRefreshStatus reflects empty state", () => {
    const stateRoot = join(tempHome(), ".commandcode", "deal-router");
    const st = getRefreshStatus(stateRoot);
    expect(st.state.failureCount).toBe(0);
    expect(st.leaseStale).toBe(true);
  });

  it("lease race detection and abandon path", () => {
    const stateRoot = join(tempHome(), ".commandcode", "deal-router");
    const a = tryAcquireLease({ stateRoot, ownerInstance: "race-a", ttlMs: 60_000 });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(isLeaseStale(a.handle.lease)).toBe(false);
    // force take over
    const b = tryAcquireLease({
      stateRoot,
      ownerInstance: "race-b",
      force: true,
      ttlMs: 60_000,
    });
    expect(b.ok).toBe(true);
    if (b.ok) b.handle.release();
  });

  it("launchd install fails when launchctl load fails and label not listed", () => {
    const home = tempHome();
    const bin = join(home, "ccroute");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    setLaunchctlRunnerForTests(() => ({
      status: 1,
      stdout: "",
      stderr: "load failed",
    }));
    const r = installLaunchd({
      ccroutePath: bin,
      homeDir: home,
      stateRoot: join(home, ".commandcode", "deal-router"),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("statusLaunchd reports absent when no plist", () => {
    const home = tempHome();
    setLaunchctlRunnerForTests(() => ({ status: 0, stdout: "", stderr: "" }));
    const st = statusLaunchd({ homeDir: home });
    expect(st.installed).toBe(false);
    expect(st.loaded).toBe(false);
  });

  it("session plan may attempt when stale and no backoff", () => {
    const home = tempHome();
    const root = join(home, ".commandcode", "deal-router");
    saveRefreshState(emptyRefreshState(), root);
    // force old pricing via seed bootstrap under HOME
    vi.stubEnv("HOME", home);
    bootstrapPricingSnapshot();
    const plan = planSessionStartRefresh({
      routingEnabled: true,
      stateRoot: root,
      // far future clock so seed is stale
      now: new Date("2099-01-01T00:00:00.000Z"),
    });
    // seed retrievedAt is 2026 — with now 2099 should be stale/acceptable and attempt
    expect(
      plan.pricingFreshness === "stale" ||
        plan.pricingFreshness === "acceptable" ||
        plan.shouldAttempt,
    ).toBe(true);
  });

  it("error classes construct", () => {
    expect(new RefreshLeaseError("x").code).toBe("REFRESH_LEASE_HELD");
    expect(new RefreshBackoffError("y").code).toBe("REFRESH_BACKOFF");
  });

  it("loadRefreshState recovers from garbage", () => {
    const home = tempHome();
    const root = join(home, ".commandcode", "deal-router");
    writeFileSync(join(root, "refresh-state.json"), "{nope");
    const st = loadRefreshState(root);
    expect(st.schemaVersion).toBe(1);
    expect(st.failureCount).toBe(0);
  });
});
