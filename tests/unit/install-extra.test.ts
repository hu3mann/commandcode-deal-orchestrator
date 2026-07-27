import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../../src/config/defaults.js";
import { sha256File, sha256Text } from "../../src/install/hash.js";
import {
  formatLifecycleResult,
  installLifecycle,
  repairLifecycle,
  statusLifecycle,
  uninstallLifecycle,
  updateLifecycle,
} from "../../src/install/lifecycle.js";
import { writeManifestAtomic } from "../../src/install/manifest.js";
import { probeModManager, sourcesFromSettingsText } from "../../src/install/mod-manager.js";
import { resolveModSource } from "../../src/install/paths.js";
import {
  INSTALL_OWNERSHIP_MARKER,
  type InstallManifest,
  MANIFEST_FILENAME,
} from "../../src/install/types.js";

function makeFakeCmd(binDir: string, opts?: { failAdd?: boolean }): string {
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "cmd");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
if [[ "\$1" == "--version" ]]; then echo "fake 1.4.1"; exit 0; fi
if [[ "\$1" == "mods" && "\$2" == "--help" ]]; then echo "Manage mods"; echo "add Install"; exit 0; fi
if [[ "\$1" == "mods" && "\$2" == "list" ]]; then echo "Mods (0)"; exit 0; fi
if [[ "\$1" == "mods" && "\$2" == "update" ]]; then echo updated; exit 0; fi
if [[ "\$1" == "mods" && "\$2" == "add" ]]; then
  ${opts?.failAdd ? "echo fail >&2; exit 3" : ""}
  scope=project; source=""; shift 2
  while [[ \$# -gt 0 ]]; do
    [[ "\$1" == "-g" ]] && { scope=user; shift; continue; }
    source="\$1"; shift
  done
  f="./.commandcode/settings.json"
  [[ "\$scope" == "user" ]] && f="\$HOME/.commandcode/settings.json"
  mkdir -p "\$(dirname "\$f")"
  node -e 'const fs=require("fs");const f=process.argv[1];const s=process.argv[2];let d={};try{d=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};d.mods=d.mods||{};d.mods.sources=[...(d.mods.sources||[]),s];fs.writeFileSync(f,JSON.stringify(d,null,2)+"\\n")' "\$f" "\$source"
  exit 0
fi
if [[ "\$1" == "mods" && "\$2" == "remove" ]]; then
  scope=project; source=""; shift 2
  while [[ \$# -gt 0 ]]; do
    [[ "\$1" == "-g" ]] && { scope=user; shift; continue; }
    source="\$1"; shift
  done
  f="./.commandcode/settings.json"
  [[ "\$scope" == "user" ]] && f="\$HOME/.commandcode/settings.json"
  node -e 'const fs=require("fs");const f=process.argv[1];const s=process.argv[2];let d={};try{d=JSON.parse(fs.readFileSync(f,"utf8"))}catch{};if(d.mods)d.mods.sources=(d.mods.sources||[]).filter(x=>x!==s);fs.writeFileSync(f,JSON.stringify(d,null,2)+"\\n")' "\$f" "\$source"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fake, 0o755);
  return fake;
}

function envBase() {
  const root = mkdtempSync(join(tmpdir(), "ccroute-extra-"));
  const projectRoot = join(root, "p");
  const homeDir = join(root, "h");
  const binDir = join(root, "b");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const cmdPath = makeFakeCmd(binDir);
  const modSource = join(packageRoot(), "src/integrations/commandcode-mod");
  return {
    projectRoot,
    homeDir,
    cmdPath,
    modSource,
    packageRoot: packageRoot(),
    env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
  };
}

describe("install extra coverage", () => {
  it("formats lifecycle results in text and json", () => {
    const r = {
      ok: false,
      operation: "install" as const,
      scope: "project" as const,
      dryRun: true,
      actions: [{ kind: "mod-add" as const, target: "/x", detail: "d" }],
      conflicts: [
        {
          path: "/y",
          reason: "user-modified" as const,
          message: "drift",
        },
      ],
      manifest: null,
      messages: ["hello"],
      error: "boom",
      exitHint: "conflict" as const,
    };
    const text = formatLifecycleResult(r, false);
    expect(text).toContain("ERROR: boom");
    expect(text).toContain("mod-add");
    expect(text).toContain("user-modified");
    expect(text).toContain("FAILED");
    const j = JSON.parse(formatLifecycleResult(r, true));
    expect(j.error).toBe("boom");
  });

  it("probeModManager reports unavailable without cmd", () => {
    const p = probeModManager(null, { ...process.env, PATH: "/none" });
    expect(p.available).toBe(false);
  });

  it("sourcesFromSettingsText parses string and object sources", () => {
    expect(sourcesFromSettingsText("")).toEqual([]);
    expect(sourcesFromSettingsText("not-json")).toEqual([]);
    expect(
      sourcesFromSettingsText(JSON.stringify({ mods: { sources: ["a", { source: "b" }] } })),
    ).toEqual(["a", "b"]);
  });

  it("resolveModSource prefers commandcode-mod package dir", () => {
    const src = resolveModSource(packageRoot());
    expect(src).toContain("commandcode-mod");
  });

  it("update refuses user-modified files without force", { timeout: 20_000 }, () => {
    const c = envBase();
    expect(installLifecycle({ project: true, skill: true, ...c }).ok).toBe(true);
    const skill = join(
      c.projectRoot,
      ".commandcode",
      "skills",
      "commandcode-deal-orchestrator",
      "SKILL.md",
    );
    writeFileSync(skill, "user changed this");
    const upd = updateLifecycle({ project: true, ...c });
    expect(upd.ok).toBe(false);
    expect(upd.exitHint).toBe("conflict");
    const forced = updateLifecycle({ project: true, force: true, ...c });
    expect(forced.ok, forced.error).toBe(true);
  });

  it("repair preserves user-modified files without force", { timeout: 20_000 }, () => {
    const c = envBase();
    expect(installLifecycle({ project: true, skill: true, ...c }).ok).toBe(true);
    const skill = join(
      c.projectRoot,
      ".commandcode",
      "skills",
      "commandcode-deal-orchestrator",
      "SKILL.md",
    );
    writeFileSync(skill, "user edit");
    const rep = repairLifecycle({ project: true, ...c });
    expect(rep.ok).toBe(true);
    expect(rep.conflicts.some((x) => x.reason === "user-modified")).toBe(true);
    expect(readFileSync(skill, "utf8")).toBe("user edit");
  });

  it("status on missing install is ok", () => {
    const c = envBase();
    const st = statusLifecycle({ project: true, ...c });
    expect(st.ok).toBe(true);
    expect(st.messages.some((m) => /Not installed/i.test(m))).toBe(true);
  });

  it("update/repair/uninstall without manifest fail closed", () => {
    const c = envBase();
    expect(updateLifecycle({ project: true, ...c }).ok).toBe(false);
    expect(repairLifecycle({ project: true, ...c }).ok).toBe(false);
    const un = uninstallLifecycle({ project: true, ...c });
    expect(un.ok).toBe(true); // nothing to uninstall
    expect(un.messages.some((m) => /Nothing to uninstall/i.test(m))).toBe(true);
  });

  it("install dry-run with --install-memory notes skip", () => {
    const c = envBase();
    const r = installLifecycle({ project: true, dryRun: true, installMemory: true, ...c });
    expect(r.ok).toBe(true);
    expect(r.messages.some((m) => /memory/i.test(m))).toBe(true);
  });

  it("mod add failure surfaces subprocess error", () => {
    const root = mkdtempSync(join(tmpdir(), "ccroute-failadd-"));
    const projectRoot = join(root, "p");
    const homeDir = join(root, "h");
    const binDir = join(root, "b");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const cmdPath = makeFakeCmd(binDir, { failAdd: true });
    const r = installLifecycle({
      project: true,
      projectRoot,
      homeDir,
      cmdPath,
      modSource: join(packageRoot(), "src/integrations/commandcode-mod"),
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
    });
    expect(r.ok).toBe(false);
    expect(r.exitHint).toBe("subprocess");
  });

  it("malformed manifest without force fails install", () => {
    const c = envBase();
    mkdirSync(join(c.projectRoot, ".commandcode"), { recursive: true });
    writeFileSync(join(c.projectRoot, ".commandcode", MANIFEST_FILENAME), '{"schemaVersion":99}\n');
    const r = installLifecycle({ project: true, ...c });
    expect(r.ok).toBe(false);
    expect(r.exitHint).toBe("config");
  });

  it("hash helpers and writeManifestAtomic round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-man-"));
    const path = join(dir, "m.json");
    const manifest: InstallManifest = {
      schemaVersion: 1,
      scope: "project",
      packageVersion: "0.2.0",
      commandCodeVersion: "1.4.1",
      modApiVersion: "ModApi@command-code-1.4.1",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      modSource: "/mod",
      managedFiles: [
        {
          path: "/f",
          sha256: sha256Text("x"),
          method: "copy",
          sourceArtifact: "skill:x",
          ownershipMarker: INSTALL_OWNERSHIP_MARKER,
        },
      ],
      managedSettingsEntries: [],
      settingsBeforeHash: sha256Text(""),
      settingsAfterHash: sha256Text("{}"),
      backupPath: "",
      installationStatus: "complete",
    };
    writeManifestAtomic(path, manifest);
    expect(sha256File(path)?.length).toBe(64);
  });

  it("force reinstall, dry-run update/repair/uninstall, hooks-only", { timeout: 45_000 }, () => {
    const c = envBase();
    const first = installLifecycle({ project: true, hooks: true, ...c });
    expect(first.ok, first.error).toBe(true);
    const forced = installLifecycle({ project: true, hooks: true, force: true, ...c });
    expect(forced.ok, forced.error).toBe(true);

    expect(updateLifecycle({ project: true, dryRun: true, ...c }).ok).toBe(true);
    expect(repairLifecycle({ project: true, dryRun: true, ...c }).ok).toBe(true);
    expect(uninstallLifecycle({ project: true, dryRun: true, ...c }).ok).toBe(true);

    // settings drift after install — still updates with force
    const settingsPath = join(c.projectRoot, ".commandcode", "settings.json");
    const cur = JSON.parse(readFileSync(settingsPath, "utf8"));
    cur.later = true;
    writeFileSync(settingsPath, `${JSON.stringify(cur, null, 2)}\n`);
    const upd = updateLifecycle({ project: true, force: true, ...c });
    expect(upd.ok, upd.error).toBe(true);

    // remove hook file and repair with force
    const hook = join(c.projectRoot, ".commandcode", "ccroute-hooks", "child-recursion-guard.mjs");
    try {
      unlinkSync(hook);
    } catch {
      /* ignore */
    }
    const rep = repairLifecycle({ project: true, force: true, ...c });
    expect(rep.ok, rep.error).toBe(true);

    const st = statusLifecycle({ project: true, ...c });
    expect(st.ok).toBe(true);
    expect(formatLifecycleResult(st, false)).toContain("OK");

    const un = uninstallLifecycle({ project: true, ...c });
    expect(un.ok, un.error).toBe(true);
  });

  it("uninstall refuses malformed settings without force", { timeout: 20_000 }, () => {
    const c = envBase();
    expect(installLifecycle({ project: true, hooks: true, ...c }).ok).toBe(true);
    writeFileSync(join(c.projectRoot, ".commandcode", "settings.json"), "{nope");
    const un = uninstallLifecycle({ project: true, ...c });
    expect(un.ok).toBe(false);
    expect(un.exitHint).toBe("config");
  });

  it("user dry-run and force install over partial", { timeout: 20_000 }, () => {
    const c = envBase();
    const dry = installLifecycle({ user: true, dryRun: true, skill: true, ...c });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    const inst = installLifecycle({ user: true, skill: true, ...c });
    expect(inst.ok, inst.error).toBe(true);
    const again = installLifecycle({ user: true, skill: true, force: true, ...c });
    expect(again.ok, again.error).toBe(true);
    expect(uninstallLifecycle({ user: true, ...c }).ok).toBe(true);
  });
});
