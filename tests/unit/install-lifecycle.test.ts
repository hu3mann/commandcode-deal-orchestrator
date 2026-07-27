import { spawnSync } from "node:child_process";
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
import { packageRoot } from "../../src/config/defaults.js";
import {
  installLifecycle,
  repairLifecycle,
  statusLifecycle,
  uninstallLifecycle,
  updateLifecycle,
} from "../../src/install/lifecycle.js";
import { readManifest } from "../../src/install/manifest.js";
import { MANIFEST_FILENAME } from "../../src/install/types.js";

const tempRoots: string[] = [];

function makeFakeCmd(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const fake = join(binDir, "cmd");
  // Simulates cmd mods add/remove/list/update writing settings.json
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
set -e
CMD_HOME="\${HOME}"
PROJECT_SETTINGS="./.commandcode/settings.json"
USER_SETTINGS="\$CMD_HOME/.commandcode/settings.json"

ensure_json() {
  local f="\$1"
  mkdir -p "\$(dirname "\$f")"
  if [[ ! -f "\$f" ]]; then
    echo '{}' > "\$f"
  fi
}

add_source() {
  local scope="\$1"
  local source="\$2"
  local f
  if [[ "\$scope" == "user" ]]; then
    f="\$USER_SETTINGS"
  else
    f="\$PROJECT_SETTINGS"
  fi
  ensure_json "\$f"
  node -e '
    const fs=require("fs");
    const f=process.argv[1];
    const source=process.argv[2];
    const data=JSON.parse(fs.readFileSync(f,"utf8"));
    data.mods=data.mods||{};
    data.mods.sources=Array.isArray(data.mods.sources)?data.mods.sources:[];
    if(!data.mods.sources.includes(source)) data.mods.sources.push(source);
    // preserve other keys
    fs.writeFileSync(f, JSON.stringify(data,null,2)+"\\n");
  ' "\$f" "\$source"
  echo "✔ Installed local:\$source"
}

remove_source() {
  local scope="\$1"
  local source="\$2"
  local f
  if [[ "\$scope" == "user" ]]; then
    f="\$USER_SETTINGS"
  else
    f="\$PROJECT_SETTINGS"
  fi
  [[ -f "\$f" ]] || exit 0
  node -e '
    const fs=require("fs");
    const f=process.argv[1];
    const source=process.argv[2];
    const data=JSON.parse(fs.readFileSync(f,"utf8"));
    if(data.mods&&Array.isArray(data.mods.sources)){
      data.mods.sources=data.mods.sources.filter(s=>s!==source && !(s&&s.source===source));
    }
    fs.writeFileSync(f, JSON.stringify(data,null,2)+"\\n");
  ' "\$f" "\$source"
  echo "✔ Removed local:\$source"
}

if [[ "\$1" == "--version" ]]; then echo "fake-cmd 1.4.1"; exit 0; fi
if [[ "\$1" == "--help" ]]; then echo "mods"; exit 0; fi
if [[ "\$1" == "mods" && "\$2" == "--help" ]]; then
  echo "Usage: cmd mods"
  echo "  add Install a mod"
  echo "Manage mods"
  exit 0
fi
if [[ "\$1" == "mods" && "\$2" == "add" ]]; then
  scope=project
  source=""
  shift 2
  while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "-g" || "\$1" == "--global" ]]; then scope=user; shift; continue; fi
    source="\$1"; shift
  done
  add_source "\$scope" "\$source"
  exit 0
fi
if [[ "\$1" == "mods" && "\$2" == "remove" ]]; then
  scope=project
  source=""
  shift 2
  while [[ \$# -gt 0 ]]; do
    if [[ "\$1" == "-g" || "\$1" == "--global" ]]; then scope=user; shift; continue; fi
    source="\$1"; shift
  done
  remove_source "\$scope" "\$source"
  exit 0
fi
if [[ "\$1" == "mods" && "\$2" == "list" ]]; then
  echo "Built-in mods (0)"
  echo "Mods (1)"
  if [[ -f "\$USER_SETTINGS" ]]; then
    echo "  package source from user"
    cat "\$USER_SETTINGS"
  fi
  if [[ -f "\$PROJECT_SETTINGS" ]]; then
    echo "  package source from project"
    cat "\$PROJECT_SETTINGS"
  fi
  exit 0
fi
if [[ "\$1" == "mods" && "\$2" == "update" ]]; then
  echo "updated"
  exit 0
fi
exit 0
`,
  );
  chmodSync(fake, 0o755);
  return fake;
}

function tempEnv(): {
  projectRoot: string;
  homeDir: string;
  cmdPath: string;
  binDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "ccroute-install-"));
  tempRoots.push(root);
  const projectRoot = join(root, "proj");
  const homeDir = join(root, "home");
  const binDir = join(root, "bin");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: projectRoot });
  // seed unrelated user settings that must be preserved
  mkdirSync(join(homeDir, ".commandcode"), { recursive: true });
  writeFileSync(
    join(homeDir, ".commandcode", "settings.json"),
    `${JSON.stringify(
      {
        permissions: { allow: ["Shell(echo)"], deny: [] },
        taste: { on: true },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }],
        },
      },
      null,
      2,
    )}\n`,
  );
  const cmdPath = makeFakeCmd(binDir);
  return { projectRoot, homeDir, cmdPath, binDir };
}

afterEach(() => {
  // leave temps for debugging if needed; OS cleans tmp
});

describe("install lifecycle", () => {
  const modSource = join(packageRoot(), "src/integrations/commandcode-mod");

  it("rejects simultaneous --project and --user", () => {
    const env = tempEnv();
    const r = installLifecycle({
      project: true,
      user: true,
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
    });
    expect(r.ok).toBe(false);
    expect(r.exitHint).toBe("usage");
  });

  it("project dry-run does not write", () => {
    const env = tempEnv();
    const r = installLifecycle({
      project: true,
      dryRun: true,
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
    });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(existsSync(join(env.projectRoot, ".commandcode", MANIFEST_FILENAME))).toBe(false);
  });

  it("project install + status + idempotent reinstall + uninstall", { timeout: 30_000 }, () => {
    const env = tempEnv();
    const common = {
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: env.homeDir, PATH: `${env.binDir}:${process.env.PATH}` },
    };

    const inst = installLifecycle({ project: true, skill: true, hooks: true, ...common });
    expect(inst.ok, inst.error).toBe(true);
    expect(inst.manifest?.installationStatus).toBe("complete");
    expect(existsSync(join(env.projectRoot, ".commandcode", MANIFEST_FILENAME))).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(env.projectRoot, ".commandcode", "settings.json"), "utf8"),
    );
    expect(settings.mods.sources).toContain(modSource);
    // skill
    expect(
      existsSync(
        join(
          env.projectRoot,
          ".commandcode",
          "skills",
          "commandcode-deal-orchestrator",
          "SKILL.md",
        ),
      ),
    ).toBe(true);

    const st = statusLifecycle({ project: true, ...common });
    expect(st.ok).toBe(true);
    expect(st.manifest?.modSource).toBe(modSource);

    const again = installLifecycle({ project: true, skill: true, hooks: true, ...common });
    expect(again.ok).toBe(true);
    expect(again.messages.some((m) => /idempotent/i.test(m))).toBe(true);

    const un = uninstallLifecycle({ project: true, ...common });
    expect(un.ok, un.error).toBe(true);
    expect(existsSync(join(env.projectRoot, ".commandcode", MANIFEST_FILENAME))).toBe(false);
    const after = JSON.parse(
      readFileSync(join(env.projectRoot, ".commandcode", "settings.json"), "utf8"),
    );
    expect(after.mods?.sources ?? []).not.toContain(modSource);
  });

  it("user install preserves unrelated settings", { timeout: 30_000 }, () => {
    const env = tempEnv();
    const common = {
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: env.homeDir, PATH: `${env.binDir}:${process.env.PATH}` },
    };
    const r = installLifecycle({ user: true, hooks: true, ...common });
    expect(r.ok, r.error).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(env.homeDir, ".commandcode", "settings.json"), "utf8"),
    );
    expect(settings.permissions.allow).toContain("Shell(echo)");
    expect(settings.taste.on).toBe(true);
    expect(JSON.stringify(settings.hooks.Stop)).toContain("user-stop");
    expect(settings.mods.sources).toContain(modSource);

    const un = uninstallLifecycle({ user: true, ...common });
    expect(un.ok, un.error).toBe(true);
    const after = JSON.parse(
      readFileSync(join(env.homeDir, ".commandcode", "settings.json"), "utf8"),
    );
    expect(after.permissions.allow).toContain("Shell(echo)");
    expect(after.taste.on).toBe(true);
    expect(JSON.stringify(after.hooks.Stop)).toContain("user-stop");
  });

  it("malformed settings stops install (no force)", () => {
    const env = tempEnv();
    mkdirSync(join(env.projectRoot, ".commandcode"), { recursive: true });
    writeFileSync(join(env.projectRoot, ".commandcode", "settings.json"), "{broken");
    const r = installLifecycle({
      project: true,
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: env.homeDir, PATH: `${env.binDir}:${process.env.PATH}` },
    });
    expect(r.ok).toBe(false);
    expect(r.exitHint).toBe("config");
  });

  it("update and repair flow", { timeout: 30_000 }, () => {
    const env = tempEnv();
    const common = {
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: env.homeDir, PATH: `${env.binDir}:${process.env.PATH}` },
    };
    expect(installLifecycle({ project: true, skill: true, ...common }).ok).toBe(true);

    // simulate missing skill file
    const skill = join(
      env.projectRoot,
      ".commandcode",
      "skills",
      "commandcode-deal-orchestrator",
      "SKILL.md",
    );
    writeFileSync(skill, "corrupted by user");
    const upd = updateLifecycle({ project: true, force: true, ...common });
    expect(upd.ok, upd.error).toBe(true);

    // remove mod from settings to force repair
    writeFileSync(
      join(env.projectRoot, ".commandcode", "settings.json"),
      `${JSON.stringify({ mods: { sources: [] }, keep: true }, null, 2)}\n`,
    );
    const rep = repairLifecycle({ project: true, force: true, ...common });
    expect(rep.ok, rep.error).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(env.projectRoot, ".commandcode", "settings.json"), "utf8"),
    );
    expect(settings.mods.sources).toContain(modSource);
    expect(settings.keep).toBe(true);

    const man = readManifest(join(env.projectRoot, ".commandcode", MANIFEST_FILENAME));
    expect(man?.installationStatus).toBe("complete");
  });

  it("missing mod manager fails closed", () => {
    const env = tempEnv();
    const r = installLifecycle({
      project: true,
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: null,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: env.homeDir, PATH: "/nonexistent" },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/mod manager|not found|not available/i);
  });

  it("handles path with spaces in project root", () => {
    const root = mkdtempSync(join(tmpdir(), "ccroute space "));
    tempRoots.push(root);
    const projectRoot = join(root, "my proj");
    const homeDir = join(root, "home");
    const binDir = join(root, "bin");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    const cmdPath = makeFakeCmd(binDir);
    const r = installLifecycle({
      project: true,
      projectRoot,
      homeDir,
      cmdPath,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: homeDir, PATH: `${binDir}:${process.env.PATH}` },
    });
    expect(r.ok, r.error).toBe(true);
    expect(existsSync(join(projectRoot, ".commandcode", MANIFEST_FILENAME))).toBe(true);
  });

  it("does not restore full settings backup on uninstall after drift", { timeout: 30_000 }, () => {
    const env = tempEnv();
    const common = {
      projectRoot: env.projectRoot,
      homeDir: env.homeDir,
      cmdPath: env.cmdPath,
      modSource,
      packageRoot: packageRoot(),
      env: { ...process.env, HOME: env.homeDir, PATH: `${env.binDir}:${process.env.PATH}` },
    };
    expect(installLifecycle({ user: true, hooks: true, ...common }).ok).toBe(true);
    // user adds new setting after install
    const settingsPath = join(env.homeDir, ".commandcode", "settings.json");
    const cur = JSON.parse(readFileSync(settingsPath, "utf8"));
    cur.userAddedAfterInstall = true;
    writeFileSync(settingsPath, `${JSON.stringify(cur, null, 2)}\n`);

    const un = uninstallLifecycle({ user: true, ...common });
    expect(un.ok, un.error).toBe(true);
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.userAddedAfterInstall).toBe(true);
    expect(after.permissions.allow).toContain("Shell(echo)");
  });
});
