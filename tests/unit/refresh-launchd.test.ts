import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLaunchdPlist,
  installLaunchd,
  resolveCcrouteAbsolute,
  setLaunchctlRunnerForTests,
  statusLaunchd,
  uninstallLaunchd,
  validatePlistXml,
} from "../../src/refresh/launchd.js";
import {
  oneLineRefreshStatus,
  planSessionStartRefresh,
  spawnNonblockingRefresh,
} from "../../src/refresh/session-start.js";
import { saveRefreshState } from "../../src/refresh/state.js";
import { emptyRefreshState } from "../../src/refresh/types.js";

function tempHome(): string {
  const d = mkdtempSync(join(tmpdir(), "ccroute-ld-"));
  mkdirSync(join(d, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(join(d, ".commandcode", "deal-router"), { recursive: true });
  return d;
}

describe("launchd lifecycle", () => {
  afterEach(() => {
    setLaunchctlRunnerForTests(null);
  });

  it("rejects non-absolute and missing ccroute paths", () => {
    const home = tempHome();
    const r1 = installLaunchd({
      ccroutePath: "relative/ccroute",
      homeDir: home,
      stateRoot: join(home, ".commandcode", "deal-router"),
    });
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/absolute/);

    const r2 = installLaunchd({
      ccroutePath: "/no/such/ccroute-bin",
      homeDir: home,
      stateRoot: join(home, ".commandcode", "deal-router"),
    });
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/not found/);
  });

  it("writes plist, installs, status, uninstalls (injected launchctl)", () => {
    const home = tempHome();
    const bin = join(home, "ccroute");
    writeFileSync(bin, "#!/bin/sh\necho ok\n");
    chmodSync(bin, 0o755);

    setLaunchctlRunnerForTests((args) => {
      if (args[0] === "list") {
        return { status: 0, stdout: "ai.commandcode.ccroute.refresh\n", stderr: "" };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    });

    const stateRoot = join(home, ".commandcode", "deal-router");
    const inst = installLaunchd({
      ccroutePath: bin,
      homeDir: home,
      stateRoot,
      workingDirectory: stateRoot,
      hour: 5,
      minute: 30,
    });
    expect(inst.ok).toBe(true);
    expect(existsSync(inst.plistPath)).toBe(true);
    const xml = readFileSync(inst.plistPath, "utf8");
    expect(validatePlistXml(xml).ok).toBe(true);
    expect(xml).toContain("<integer>5</integer>");
    expect(xml).not.toMatch(/KeepAlive>\s*<true/i);

    const again = installLaunchd({
      ccroutePath: bin,
      homeDir: home,
      stateRoot,
    });
    expect(again.ok).toBe(true);

    const st = statusLaunchd({ homeDir: home });
    expect(st.installed).toBe(true);
    expect(st.loaded).toBe(true);
    expect(st.plist).toContain("ai.commandcode.ccroute.refresh");

    const un = uninstallLaunchd({ homeDir: home });
    expect(un.ok).toBe(true);
    expect(existsSync(inst.plistPath)).toBe(false);

    const un2 = uninstallLaunchd({ homeDir: home });
    expect(un2.ok).toBe(true);
    expect(un2.messages.some((m) => /absent/i.test(m))).toBe(true);
  });

  it("validatePlistXml rejects bad contracts", () => {
    expect(validatePlistXml("<plist></plist>").ok).toBe(false);
    const good = buildLaunchdPlist({
      ccroutePath: "/usr/local/bin/ccroute",
      homeDir: "/tmp/h",
    });
    expect(validatePlistXml(good).ok).toBe(true);
    const badKeep = good.replace("<false/>", "<true/>");
    // only first false is RunAtLoad — force KeepAlive true more carefully
    const badKeep2 = good.replace(
      /<key>KeepAlive<\/key>\s*<false\/>/,
      "<key>KeepAlive</key>\n  <true/>",
    );
    expect(validatePlistXml(badKeep2).ok).toBe(false);
    expect(validatePlistXml("<plist>ai.commandcode.ccroute.refresh bash -c evil</plist>").ok).toBe(
      false,
    );
    void badKeep;
  });

  it("resolveCcrouteAbsolute is callable", () => {
    const r = resolveCcrouteAbsolute({ ...process.env, PATH: "/none" });
    expect(r === null || typeof r === "string").toBe(true);
  });
});

describe("session-start refresh", () => {
  it("plans skip when routing disabled", () => {
    const disabled = planSessionStartRefresh({ routingEnabled: false });
    expect(disabled.shouldAttempt).toBe(false);
    expect(disabled.reason).toMatch(/disabled/i);
    expect(disabled.staticContextLines.some((l) => /authorization/i.test(l))).toBe(true);
  });

  it("plans skip when backoff active via stateRoot", () => {
    const home = tempHome();
    const root = join(home, ".commandcode", "deal-router");
    saveRefreshState(
      {
        ...emptyRefreshState(),
        nextEligibleAttemptAt: new Date(Date.now() + 120_000).toISOString(),
        failureCount: 2,
      },
      root,
    );
    const plan = planSessionStartRefresh({
      routingEnabled: true,
      stateRoot: root,
    });
    expect(plan.shouldAttempt).toBe(false);
    expect(plan.reason).toMatch(/backoff/i);
  });

  it("plans skip when healthy lease held", () => {
    const home = tempHome();
    const root = join(home, ".commandcode", "deal-router");
    const now = new Date();
    saveRefreshState(
      {
        ...emptyRefreshState(),
        activeLease: {
          ownerPid: 1,
          ownerInstance: "hold-1",
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        },
      },
      root,
    );
    const plan = planSessionStartRefresh({ routingEnabled: true, stateRoot: root, now });
    expect(plan.shouldAttempt).toBe(false);
    expect(plan.reason).toMatch(/lease/i);
  });

  it("oneLineRefreshStatus reports error, success, and empty", () => {
    const home = tempHome();
    const root = join(home, ".commandcode", "deal-router");
    saveRefreshState({ ...emptyRefreshState(), lastError: "network down", failureCount: 1 }, root);
    expect(oneLineRefreshStatus(root)).toMatch(/last error/);
    saveRefreshState(
      {
        ...emptyRefreshState(),
        lastSuccessAt: "2026-01-01T00:00:00.000Z",
        failureCount: 0,
        lastError: null,
      },
      root,
    );
    expect(oneLineRefreshStatus(root)).toMatch(/last success/);
    saveRefreshState(emptyRefreshState(), root);
    expect(oneLineRefreshStatus(root)).toMatch(/no successful run/);
  });

  it("spawnNonblockingRefresh returns a result object", () => {
    const r = spawnNonblockingRefresh({
      ccroutePath: process.execPath,
      extraArgs: ["-e", "0"],
    });
    expect(typeof r.spawned).toBe("boolean");
  });
});
