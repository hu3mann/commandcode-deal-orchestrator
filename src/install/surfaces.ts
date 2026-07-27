/**
 * Optional install surfaces: skill copy + hook fallback file install.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { sha256File } from "./hash.js";
import type { InstallPaths } from "./paths.js";
import {
  type HookSpec,
  backupSettings,
  hookIdentity,
  loadSettings,
  mergeHooks,
  unmergeHooks,
  writeSettingsAtomic,
} from "./settings-custody.js";
import {
  HOOK_OWNERSHIP_MARKER,
  INSTALL_OWNERSHIP_MARKER,
  type ManagedFileEntry,
  type ManagedSettingsEntry,
} from "./types.js";

function copyFileTracked(src: string, dest: string, sourceArtifact: string): ManagedFileEntry {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  try {
    const mode = statSync(src).mode & 0o777;
    chmodSync(dest, mode);
  } catch {
    /* best-effort */
  }
  const hash = sha256File(dest) ?? "";
  return {
    path: dest,
    sha256: hash,
    method: "copy",
    sourceArtifact,
    ownershipMarker: INSTALL_OWNERSHIP_MARKER,
  };
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

export function installSkillSurface(paths: InstallPaths): ManagedFileEntry[] {
  if (!existsSync(paths.skillSourceDir)) return [];
  const entries: ManagedFileEntry[] = [];
  for (const src of walkFiles(paths.skillSourceDir)) {
    const rel = relative(paths.skillSourceDir, src);
    const dest = join(paths.skillDestDir, rel);
    entries.push(copyFileTracked(src, dest, `skill:${rel}`));
  }
  // ownership marker file
  const marker = join(paths.skillDestDir, ".ccroute-owned");
  writeFileSync(marker, `${INSTALL_OWNERSHIP_MARKER}\n`, "utf8");
  entries.push({
    path: marker,
    sha256: sha256File(marker) ?? "",
    method: "copy",
    sourceArtifact: "skill:ownership-marker",
    ownershipMarker: INSTALL_OWNERSHIP_MARKER,
  });
  return entries;
}

export function removeSkillSurface(paths: InstallPaths, managed: ManagedFileEntry[]): void {
  for (const f of managed) {
    if (f.sourceArtifact.startsWith("skill:") && existsSync(f.path)) {
      try {
        rmSync(f.path, { force: true });
      } catch {
        /* v8 ignore next — best-effort cleanup */
      }
    }
  }
  if (existsSync(paths.skillDestDir)) {
    try {
      rmSync(paths.skillDestDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

export interface HooksInstallResult {
  files: ManagedFileEntry[];
  settingsEntries: ManagedSettingsEntry[];
  settingsBeforeHash: string;
  settingsAfterHash: string;
  backupPath: string;
  skipped?: string;
}

function shellQuote(path: string): string {
  // POSIX single-quote escaping for paths that may contain spaces/metacharacters
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

export function buildHookSpecs(hooksDestDir: string): HookSpec[] {
  const guard = join(hooksDestDir, "child-recursion-guard.mjs");
  const session = join(hooksDestDir, "child-session-context.mjs");
  return [
    {
      event: "SessionStart",
      command: `node ${shellQuote(session)} # ${HOOK_OWNERSHIP_MARKER}`,
      timeout: 2,
    },
    {
      event: "PreToolUse",
      matcher: "shell",
      command: `node ${shellQuote(guard)} # ${HOOK_OWNERSHIP_MARKER}`,
      timeout: 2,
    },
  ];
}

export function installHooksSurface(
  paths: InstallPaths,
  opts?: { force?: boolean },
): HooksInstallResult {
  const files: ManagedFileEntry[] = [];
  mkdirSync(paths.hooksDestDir, { recursive: true });

  for (const name of ["child-recursion-guard.mjs", "child-session-context.mjs"]) {
    const src = join(paths.hooksSourceDir, name);
    if (!existsSync(src)) continue;
    const dest = join(paths.hooksDestDir, name);
    files.push(copyFileTracked(src, dest, `hook:${name}`));
  }

  const loaded = loadSettings(paths.settingsPath);
  if (loaded.parseError) {
    return {
      files,
      settingsEntries: [],
      settingsBeforeHash: loaded.hash,
      settingsAfterHash: loaded.hash,
      backupPath: "",
      skipped: `malformed settings: ${loaded.parseError}`,
    };
  }

  const beforeHash = loaded.hash;
  const backupPath = backupSettings(paths.settingsPath, paths.backupDir) ?? "";
  const specs = buildHookSpecs(paths.hooksDestDir);
  const { data, identities } = mergeHooks(loaded.data ?? {}, specs);
  const written = writeSettingsAtomic(paths.settingsPath, data, {
    previousMode: loaded.mode,
  });

  const settingsEntries: ManagedSettingsEntry[] = specs.map((spec, i) => ({
    settingsPath: paths.settingsPath,
    identity: identities[i]!,
    event: spec.event,
    matcher: spec.matcher,
    command: spec.command,
    ownershipMarker: HOOK_OWNERSHIP_MARKER,
  }));

  void opts;
  return {
    files,
    settingsEntries,
    settingsBeforeHash: beforeHash,
    settingsAfterHash: written.hash,
    backupPath,
  };
}

export function removeHooksSurface(
  paths: InstallPaths,
  settingsEntries: ManagedSettingsEntry[],
  managedFiles: ManagedFileEntry[],
): { settingsAfterHash: string; skipped?: string } {
  for (const f of managedFiles) {
    if (f.sourceArtifact.startsWith("hook:") && existsSync(f.path)) {
      try {
        rmSync(f.path, { force: true });
      } catch {
        /* v8 ignore next — best-effort cleanup */
      }
    }
  }
  if (existsSync(paths.hooksDestDir)) {
    try {
      rmSync(paths.hooksDestDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  const loaded = loadSettings(paths.settingsPath);
  if (loaded.parseError || !loaded.data) {
    return {
      settingsAfterHash: loaded.hash,
      skipped: loaded.parseError
        ? `malformed settings, not restoring: ${loaded.parseError}`
        : undefined,
    };
  }
  const identities = settingsEntries.map((e) => e.identity);
  // also recompute from specs if empty
  if (identities.length === 0) {
    for (const spec of buildHookSpecs(paths.hooksDestDir)) {
      identities.push(hookIdentity(spec));
    }
  }
  const next = unmergeHooks(loaded.data, identities);
  const written = writeSettingsAtomic(paths.settingsPath, next, {
    previousMode: loaded.mode,
  });
  return { settingsAfterHash: written.hash };
}

export function detectManagedFileDrift(
  managed: ManagedFileEntry[],
): { path: string; expected: string; actual: string | null }[] {
  const drifts: { path: string; expected: string; actual: string | null }[] = [];
  for (const f of managed) {
    if (f.method === "mod-manager" || f.method === "settings-merge") continue;
    const actual = sha256File(f.path);
    if (actual !== f.sha256) {
      drifts.push({ path: f.path, expected: f.sha256, actual });
    }
  }
  return drifts;
}

export function readTextIfExists(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}
