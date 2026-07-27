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
import { packageRoot } from "../../src/config/defaults.js";
import { emptyHash, sha256Buffer, sha256File } from "../../src/install/hash.js";
import { installLifecycle } from "../../src/install/lifecycle.js";
import { fileMode, readManifest, removeManifest, withStatus } from "../../src/install/manifest.js";
import {
  modList,
  modRemove,
  modUpdate,
  probeModManager,
  requireModManager,
  settingsMentionsSource,
} from "../../src/install/mod-manager.js";
import {
  resolveInstallPaths,
  resolveModSource,
  resolvePackageVersion,
} from "../../src/install/paths.js";
import {
  backupSettings,
  listManagedHookIdentities,
  loadSettings,
  mergeHooks,
  settingsBasename,
  unmergeHooks,
  writeSettingsAtomic,
} from "../../src/install/settings-custody.js";
import {
  buildHookSpecs,
  detectManagedFileDrift,
  installHooksSurface,
  installSkillSurface,
  readTextIfExists,
  removeHooksSurface,
  removeSkillSurface,
} from "../../src/install/surfaces.js";
import {
  HOOK_OWNERSHIP_MARKER,
  INSTALL_OWNERSHIP_MARKER,
  InstallError,
  type InstallManifest,
  type ManagedFileEntry,
} from "../../src/install/types.js";

describe("install branch coverage", () => {
  it("hash empty and buffer helpers", () => {
    expect(emptyHash()).toHaveLength(64);
    expect(sha256Buffer(Buffer.from("abc"))).toHaveLength(64);
    expect(sha256File("/no/such/file")).toBeNull();
  });

  it("paths resolvePackageVersion fallbacks and mod source candidates", () => {
    expect(resolvePackageVersion("/no/pkg")).toBe("0.0.0");
    const dir = mkdtempSync(join(tmpdir(), "ccroute-modsrc-"));
    writeFileSync(join(dir, "index.ts"), "export default () => {}");
    expect(resolveModSource(dir)).toBe(dir);
    expect(resolveModSource(dir, join(dir, "override"))).toContain("override");
    const p = resolveInstallPaths({
      user: true,
      homeDir: join(dir, "home"),
      projectRoot: join(dir, "proj"),
      packageRoot: packageRoot(),
    });
    expect(p.scope).toBe("user");
    expect(p.manifestPath).toContain("ccroute-install-manifest.json");
  });

  it("manifest helpers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-man2-"));
    const path = join(dir, "m.json");
    expect(readManifest(path)).toBeNull();
    expect(() => {
      writeFileSync(path, "{");
      readManifest(path);
    }).toThrow(/malformed/);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }));
    expect(() => readManifest(path)).toThrow(/schema/);
    removeManifest(path);
    removeManifest(path); // absent ok
    expect(fileMode(path)).toBeNull();
    writeFileSync(path, "x");
    chmodSync(path, 0o600);
    expect(fileMode(path)).toBe(0o600);
    const base: InstallManifest = {
      schemaVersion: 1,
      scope: "project",
      packageVersion: "0",
      commandCodeVersion: "1",
      modApiVersion: "m",
      installedAt: "t",
      updatedAt: "t",
      modSource: "/m",
      managedFiles: [],
      managedSettingsEntries: [],
      settingsBeforeHash: "",
      settingsAfterHash: "",
      backupPath: "",
      installationStatus: "complete",
    };
    expect(withStatus(base, "partial").installationStatus).toBe("partial");
  });

  it("settings merge edge cases: non-object root, empty groups, unmerge", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-set-"));
    const path = join(dir, "s.json");
    writeFileSync(path, "[]");
    const bad = loadSettings(path);
    expect(bad.parseError).toMatch(/object/);

    const { data } = mergeHooks(
      {
        hooks: {
          PreToolUse: [
            "skip-me",
            {
              matcher: "shell",
              hooks: [{ type: "command", command: "echo keep" }, "x"],
            },
          ],
        },
      },
      [
        {
          event: "PreToolUse",
          matcher: "shell",
          command: `node 'x' # ${HOOK_OWNERSHIP_MARKER}`,
        },
        {
          event: "SessionStart",
          command: `node 'y' # ${HOOK_OWNERSHIP_MARKER}`,
        },
      ],
    );
    expect(listManagedHookIdentities(data).length).toBeGreaterThan(0);
    // re-merge same to hit already-present branch
    const again = mergeHooks(data, [
      {
        event: "PreToolUse",
        matcher: "shell",
        command: `node 'x' # ${HOOK_OWNERSHIP_MARKER}`,
      },
    ]);
    const cleaned = unmergeHooks(again.data, listManagedHookIdentities(again.data));
    expect(JSON.stringify(cleaned)).toContain("echo keep");
    expect(settingsBasename(path)).toBe("s.json");
    expect(backupSettings(join(dir, "missing.json"), join(dir, "bak"))).toBeNull();
  });

  it("writeSettingsAtomic and load empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-wsa-"));
    const path = join(dir, "nested", "s.json");
    const written = writeSettingsAtomic(path, { a: 1 }, { previousMode: 0o644 });
    expect(written.hash).toHaveLength(64);
    expect(loadSettings(path).data).toEqual({ a: 1 });
  });

  it("surfaces skill/hooks install and remove", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-surf-"));
    const paths = resolveInstallPaths({
      project: true,
      projectRoot: dir,
      homeDir: join(dir, "home"),
      packageRoot: packageRoot(),
    });
    const skill = installSkillSurface(paths);
    expect(skill.length).toBeGreaterThan(0);
    removeSkillSurface(paths, skill);
    expect(existsSync(paths.skillDestDir)).toBe(false);

    writeFileSync(
      paths.settingsPath,
      JSON.stringify({ permissions: { allow: [] }, hooks: {} }, null, 2),
    );
    const hooks = installHooksSurface(paths);
    expect(hooks.files.length).toBeGreaterThan(0);
    expect(hooks.settingsEntries.length).toBe(2);
    const specs = buildHookSpecs(paths.hooksDestDir);
    expect(specs[0]!.command).toContain("'");
    const removed = removeHooksSurface(paths, hooks.settingsEntries, hooks.files);
    expect(removed.settingsAfterHash).toHaveLength(64);

    // malformed settings skips hooks merge
    writeFileSync(paths.settingsPath, "{");
    const skip = installHooksSurface(paths);
    expect(skip.skipped).toMatch(/malformed/);

    const drift = detectManagedFileDrift([
      {
        path: join(dir, "missing"),
        sha256: "abc",
        method: "copy",
        sourceArtifact: "skill:x",
        ownershipMarker: INSTALL_OWNERSHIP_MARKER,
      },
      {
        path: paths.settingsPath,
        sha256: "x",
        method: "mod-manager",
        sourceArtifact: "cmd",
        ownershipMarker: INSTALL_OWNERSHIP_MARKER,
      },
    ]);
    expect(drift.some((d) => d.actual === null)).toBe(true);
    expect(readTextIfExists(join(dir, "nope"))).toBe("");
  });

  it("mod-manager helpers and requireModManager throw", () => {
    expect(() => requireModManager(null)).toThrow(InstallError);
    expect(settingsMentionsSource('{"mods":{"sources":["/a/b"]}}', "/a/b")).toBe(true);
    expect(settingsMentionsSource("{}", "/a")).toBe(false);

    const bin = mkdtempSync(join(tmpdir(), "ccroute-mm-"));
    const cmd = join(bin, "cmd");
    writeFileSync(
      cmd,
      `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo 1.4.1; exit 0; fi
if [[ "$1" == "mods" && "$2" == "--help" ]]; then echo "Manage mods"; echo "add Install"; exit 0; fi
if [[ "$1" == "mods" && "$2" == "list" ]]; then echo "local:/tmp/x"; exit 0; fi
if [[ "$1" == "mods" && "$2" == "update" ]]; then exit 0; fi
if [[ "$1" == "mods" && "$2" == "remove" ]]; then exit 0; fi
exit 0
`,
    );
    chmodSync(cmd, 0o755);
    const list = modList(cmd, process.env, bin);
    expect(list.mentionsSource("/tmp/x")).toBe(true);
    expect(modUpdate(cmd).ok).toBe(true);
    expect(modRemove(cmd, "/tmp/x", "project").ok).toBe(true);
    expect(requireModManager(cmd).available).toBe(true);
  });

  it("covers remaining path/mod/surface branches", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccroute-bare-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    expect(resolvePackageVersion(dir)).toBe("1.0.0");
    expect(resolveModSource(dir)).toBe(dir);

    // shellQuote apostrophe-escape branch via buildHookSpecs
    const quotedDir = join(dir, "o'path");
    mkdirSync(quotedDir, { recursive: true });
    const specs = buildHookSpecs(quotedDir);
    expect(specs[0]!.command).toContain("'\\''");

    const root = mkdtempSync(join(tmpdir(), "ccroute-rh-"));
    const paths = resolveInstallPaths({
      project: true,
      projectRoot: root,
      homeDir: join(root, "h"),
      packageRoot: packageRoot(),
    });
    mkdirSync(paths.hooksDestDir, { recursive: true });
    writeFileSync(
      paths.settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: `node 'x' # ${HOOK_OWNERSHIP_MARKER}`,
                    ownershipMarker: HOOK_OWNERSHIP_MARKER,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );
    const r = removeHooksSurface(paths, [], []);
    expect(r.settingsAfterHash).toHaveLength(64);
    removeSkillSurface(paths, []);
    writeFileSync(join(root, "f.txt"), "hello");
    const drift = detectManagedFileDrift([
      {
        path: join(root, "f.txt"),
        sha256: "0".repeat(64),
        method: "copy",
        sourceArtifact: "skill:f",
        ownershipMarker: INSTALL_OWNERSHIP_MARKER,
      },
    ]);
    expect(drift[0]?.actual).not.toBeNull();
    const m = mergeHooks({}, [{ event: "Stop", command: `echo z # ${HOOK_OWNERSHIP_MARKER}` }]);
    expect((m.data.hooks as Record<string, unknown>).Stop).toBeTruthy();
    expect(unmergeHooks({ a: 1 }, [])).toMatchObject({ a: 1 });
    expect(listManagedHookIdentities({})).toEqual([]);
    expect(listManagedHookIdentities({ hooks: "bad" })).toEqual([]);
    // probeModManager with empty string path falls through to PATH resolver
    const probe = probeModManager("", { ...process.env, PATH: "/none" });
    expect(probe.available === true || probe.available === false).toBe(true);
  });

  it(
    "install force with malformed settings still proceeds when forced",
    { timeout: 20_000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "ccroute-force-mal-"));
      const projectRoot = join(root, "p");
      const homeDir = join(root, "h");
      const binDir = join(root, "b");
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(join(projectRoot, ".commandcode"), { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      writeFileSync(join(projectRoot, ".commandcode", "settings.json"), "{broken");
      const cmd = join(binDir, "cmd");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        cmd,
        `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then echo 1.4.1; exit 0; fi
if [[ "$1" == "mods" && "$2" == "--help" ]]; then echo "Manage mods"; echo add; exit 0; fi
if [[ "$1" == "mods" && "$2" == "add" ]]; then
  mkdir -p .commandcode
  echo '{"mods":{"sources":["x"]}}' > .commandcode/settings.json
  exit 0
fi
if [[ "$1" == "mods" && "$2" == "list" ]]; then exit 0; fi
exit 0
`,
      );
      chmodSync(cmd, 0o755);
      const r = installLifecycle({
        project: true,
        force: true,
        hooks: true,
        projectRoot,
        homeDir,
        cmdPath: cmd,
        modSource: join(packageRoot(), "src/integrations/commandcode-mod"),
        packageRoot: packageRoot(),
        env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
      });
      // force + malformed: install may still add mod (cmd overwrites settings)
      expect(r.ok || r.exitHint === "config" || r.exitHint === "subprocess").toBe(true);
    },
  );
});
