/**
 * TP-CCROUTE-AUTO-004: agents, memory, live-catalog reconciliation contracts.
 */
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
import { describe, expect, it } from "vitest";
import {
  MANAGED_AGENT_NAMES,
  agentDestPath,
  agentsRefreshStatePath,
  installAgentsSurface,
  listBundledAgents,
  loadAgentsRefreshState,
  parseAgentMarkdown,
  readBundledAgent,
  refreshManagedAgents,
  removeAgentsSurface,
  serializeAgentMarkdown,
} from "../../src/agents/index.js";
import { packageRoot } from "../../src/config/defaults.js";
import type { PricingSnapshot } from "../../src/domain/model.js";
import {
  installLifecycle,
  resolveInstallPaths,
  uninstallLifecycle,
} from "../../src/install/index.js";
import {
  DEFAULT_MEMORY_BODY,
  extractManagedMemory,
  installMemoryBlock,
  memoryBlockPresent,
  removeMemoryBlock,
} from "../../src/install/memory.js";
import {
  mapPricingIdToLive,
  reconcileLiveCatalog,
} from "../../src/pricing/reconcile-live-catalog.js";
import {
  computePricingSourceHash,
  loadPricingSnapshot,
  savePricingSnapshot,
} from "../../src/pricing/snapshot.js";

function makeFakeCmd(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "cmd");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo "fake 1.4.1"; exit 0; fi
if [[ "$1" == "mods" && "$2" == "--help" ]]; then
  echo "Manage mods"; echo "add Install a mod"; exit 0
fi
if [[ "$1" == "mods" ]]; then exit 0; fi
if [[ "$1" == "--list-models" ]]; then
  echo "Available models"
  echo "deepseek/deepseek-v4-flash"
  echo "xai/grok-4.5"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fake, 0o755);
  return fake;
}

function envBase() {
  const root = mkdtempSync(join(tmpdir(), "ccroute-004-"));
  const projectRoot = join(root, "p");
  const homeDir = join(root, "h");
  const binDir = join(root, "b");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const cmdPath = makeFakeCmd(binDir);
  return {
    projectRoot,
    homeDir,
    cmdPath,
    modSource: join(packageRoot(), "src/integrations/commandcode-mod"),
    packageRoot: packageRoot(),
    env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
  };
}

describe("TP004 agents", () => {
  it("parse/serialize agent frontmatter edges and listBundledAgents", () => {
    expect(listBundledAgents().length).toBe(3);
    const bundled = readBundledAgent("ccroute-explorer");
    expect(bundled.frontmatter.delegation).toBe(false);
    const text = serializeAgentMarkdown(
      {
        name: "ccroute-explorer",
        description: "x",
        model: "inherit",
        tools: ["read"],
        maxTurns: 3,
        delegation: false,
      },
      "body",
    );
    const again = parseAgentMarkdown(text);
    expect(again.frontmatter.maxTurns).toBe(3);
    expect(() => parseAgentMarkdown("no frontmatter")).toThrow(/frontmatter/i);
  });

  it("installs planner/reviewer/explorer with project model inherit", () => {
    const c = envBase();
    const r = installLifecycle({ project: true, skill: true, ...c });
    expect(r.ok, r.error).toBe(true);
    const paths = resolveInstallPaths({ project: true, ...c });
    for (const name of MANAGED_AGENT_NAMES) {
      const p = agentDestPath(paths, name);
      expect(existsSync(p), name).toBe(true);
      const text = readFileSync(p, "utf8");
      const parsed = parseAgentMarkdown(text);
      expect(parsed.frontmatter.model).toBe("inherit");
      expect(parsed.frontmatter.name).toBe(name);
    }
  });

  it("refresh refuses unavailable pin and accepts exact live pin on user scope", () => {
    const c = envBase();
    const paths = resolveInstallPaths({ user: true, ...c });
    // refresh installs missing agents first
    const first = refreshManagedAgents({
      paths,
      liveIds: ["deepseek/deepseek-v4-flash"],
    });
    expect(first.ok).toBe(true);
    expect(first.messages.some((m) => /Installed missing/i.test(m))).toBe(true);

    const bad = refreshManagedAgents({
      paths,
      liveIds: ["deepseek/deepseek-v4-flash"],
      pinModel: "not-a-real-model",
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/not in the live catalog/i);

    const promo = refreshManagedAgents({
      paths,
      liveIds: ["vendor/promo-free"],
      pinModel: "vendor/promo-free",
    });
    expect(promo.ok).toBe(false);
    expect(promo.error).toMatch(/promotional/i);

    const promoOk = refreshManagedAgents({
      paths,
      liveIds: ["vendor/promo-free"],
      pinModel: "vendor/promo-free",
      allowPromotionalPins: true,
    });
    expect(promoOk.ok).toBe(true);

    const ok = refreshManagedAgents({
      paths,
      liveIds: ["deepseek/deepseek-v4-flash", "xai/grok-4.5"],
      pinModel: "deepseek/deepseek-v4-flash",
    });
    expect(ok.ok).toBe(true);
    expect(ok.selectedIds["ccroute-planner"]).toBe("deepseek/deepseek-v4-flash");

    // project refresh forces inherit
    const proj = resolveInstallPaths({ project: true, ...c });
    installAgentsSurface(proj);
    const projRef = refreshManagedAgents({
      paths: proj,
      liveIds: ["deepseek/deepseek-v4-flash"],
      pinModel: null,
    });
    expect(projRef.selectedIds["ccroute-planner"]).toBe("inherit");
  });

  it("removeAgentsSurface clears managed agent files", () => {
    const c = envBase();
    const paths = resolveInstallPaths({ project: true, ...c });
    const entries = installAgentsSurface(paths);
    expect(entries.length).toBeGreaterThan(0);
    removeAgentsSurface(paths, entries);
    expect(existsSync(agentDestPath(paths, "ccroute-planner"))).toBe(false);
  });
});

describe("TP004 memory", () => {
  it("installs and removes only the managed AGENTS.md block", () => {
    const c = envBase();
    const paths = resolveInstallPaths({ project: true, ...c });
    // empty AGENTS path
    expect(memoryBlockPresent(paths)).toBe(false);
    expect(removeMemoryBlock(paths).removed).toBe(false);

    writeFileSync(join(c.projectRoot, "AGENTS.md"), "# User rules\n\nKeep my notes.\n");
    expect(removeMemoryBlock(paths).messages.some((m) => /No managed/i.test(m))).toBe(true);

    const entry = installMemoryBlock(paths);
    expect(entry.sourceArtifact).toBe("memory:AGENTS.md");
    expect(memoryBlockPresent(paths)).toBe(true);
    // reinstall over existing block
    installMemoryBlock(paths, "Updated policy line.");
    const text = readFileSync(join(c.projectRoot, "AGENTS.md"), "utf8");
    expect(text).toContain("Keep my notes");
    expect(text).toContain("Updated policy line");
    const extracted = extractManagedMemory(text);
    expect(extracted.hasBlock).toBe(true);

    const rem = removeMemoryBlock(paths);
    expect(rem.removed).toBe(true);
    const after = readFileSync(join(c.projectRoot, "AGENTS.md"), "utf8");
    expect(after).toContain("Keep my notes");
    expect(memoryBlockPresent(paths)).toBe(false);

    // fresh empty project: install creates file
    const c2 = envBase();
    const p2 = resolveInstallPaths({ project: true, ...c2 });
    installMemoryBlock(p2);
    expect(memoryBlockPresent(p2)).toBe(true);
  });

  it("install --install-memory writes block; uninstall --remove-memory cleans it", () => {
    const c = envBase();
    const inst = installLifecycle({ project: true, installMemory: true, ...c });
    expect(inst.ok, inst.error).toBe(true);
    expect(memoryBlockPresent(resolveInstallPaths({ project: true, ...c }))).toBe(true);
    const un = uninstallLifecycle({ project: true, removeMemory: true, ...c });
    expect(un.ok, un.error).toBe(true);
    expect(memoryBlockPresent(resolveInstallPaths({ project: true, ...c }))).toBe(false);
  });
});

describe("TP004 reconcile-live-catalog", () => {
  it("maps exact and unique provider+name; quarantines ambiguous and unmapped", () => {
    expect(mapPricingIdToLive("a/b", ["a/b"]).bucket).toBe("mapped");
    expect(mapPricingIdToLive("xai/Grok-4.5", ["xai/grok-4.5"]).bucket).toBe("mapped");
    // Same provider + same normalized name → multiple candidates → ambiguous
    expect(mapPricingIdToLive("xai/Grok-4.5", ["xai/grok-4-5", "xai/grok45"]).bucket).toBe(
      "ambiguous",
    );
    expect(mapPricingIdToLive("nope/missing", ["a/b"]).bucket).toBe("quarantined");

    const pricing: PricingSnapshot = {
      schemaVersion: 1,
      retrievedAt: "2026-01-01T00:00:00.000Z",
      source: "test",
      sourceHash: "x",
      models: [
        {
          id: "deepseek/deepseek-v4-flash",
          contextWindow: 128000,
          inputPerMillion: 0.1,
          outputPerMillion: 0.2,
          priceBasis: "post_discount",
          qualityTier: "economical",
          availability: "available",
        },
        {
          id: "ghost/vanished",
          contextWindow: 128000,
          inputPerMillion: 1,
          outputPerMillion: 2,
          priceBasis: "post_discount",
          qualityTier: "capable",
          availability: "available",
        },
      ],
    };
    // force correct hash shape is not required for reconcile input
    const report = reconcileLiveCatalog({
      liveIds: ["deepseek/deepseek-v4-flash", "live/only"],
      pricing,
      applyAvailability: false,
    });
    expect(report.mapped.some((e) => e.pricingId === "deepseek/deepseek-v4-flash")).toBe(true);
    expect(report.quarantined.some((e) => e.pricingId === "ghost/vanished")).toBe(true);
    expect(report.liveOnly).toContain("live/only");
    expect(report.wrote).toBe(false);

    // ambiguous path fills both ambiguous + quarantined
    const ambPricing: PricingSnapshot = {
      ...pricing,
      models: [
        {
          id: "xai/Grok-4.5",
          contextWindow: 128000,
          inputPerMillion: 1,
          outputPerMillion: 2,
          priceBasis: "post_discount",
          qualityTier: "frontier",
          availability: "available",
        },
      ],
    };
    const amb = reconcileLiveCatalog({
      liveIds: ["xai/grok-4-5", "xai/grok45"],
      pricing: ambPricing,
      applyAvailability: false,
    });
    expect(amb.ambiguous.length).toBe(1);
    expect(amb.quarantined.length).toBeGreaterThanOrEqual(1);

    // applyAvailability persists availability-only updates under HOME state
    const home = mkdtempSync(join(tmpdir(), "rec-home-"));
    process.env.HOME = home;
    mkdirSync(join(home, ".commandcode", "deal-router"), { recursive: true });
    const seed = loadPricingSnapshot();
    // ensure hash-valid seed write
    savePricingSnapshot(seed);
    const applied = reconcileLiveCatalog({
      liveIds: seed.models.slice(0, 1).map((m) => m.id),
      applyAvailability: true,
    });
    expect(applied.wrote).toBe(true);
    expect(applied.ok).toBe(true);
    void computePricingSourceHash;
  });

  it("loadAgentsRefreshState recovers corrupt and missing files", () => {
    const c = envBase();
    const paths = resolveInstallPaths({ project: true, ...c });
    expect(loadAgentsRefreshState(paths)).toBeNull();
    mkdirSync(join(paths.commandcodeDir, "agents"), { recursive: true });
    writeFileSync(agentsRefreshStatePath(paths), "{nope");
    expect(loadAgentsRefreshState(paths)).toBeNull();
  });
});
