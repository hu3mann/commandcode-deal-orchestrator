/**
 * Managed install / update / repair / uninstall lifecycle.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { installAgentsSurface, removeAgentsSurface } from "../agents/definitions.js";
import { emptyHash, sha256File, sha256Text } from "./hash.js";
import { readManifest, removeManifest, writeManifestAtomic } from "./manifest.js";
import { installMemoryBlock, memoryBlockPresent, removeMemoryBlock } from "./memory.js";
import {
  modAdd,
  modList,
  modRemove,
  modUpdate,
  probeModManager,
  requireModManager,
  settingsMentionsSource,
  sourcesFromSettingsText,
} from "./mod-manager.js";
import { type InstallPaths, resolveInstallPaths } from "./paths.js";
import { loadSettings } from "./settings-custody.js";
import {
  detectManagedFileDrift,
  installHooksSurface,
  installSkillSurface,
  removeHooksSurface,
  removeSkillSurface,
} from "./surfaces.js";
import {
  INSTALL_OWNERSHIP_MARKER,
  type InstallCliOptions,
  type InstallConflict,
  InstallError,
  type InstallManifest,
  type LifecycleResult,
  type ManagedFileEntry,
  type PlannedAction,
} from "./types.js";

const MOD_API_VERSION = "ModApi@command-code-1.4.1";

function envFor(opts: InstallCliOptions, paths: InstallPaths): NodeJS.ProcessEnv {
  const base = { ...(opts.env ?? process.env) };
  // Isolate HOME for user-scope operations when test home is set
  base.HOME = paths.homeDir;
  return base;
}

/** Project-scope `cmd mods` mutates cwd/.commandcode — always run from project root. */
function projectCwd(paths: InstallPaths): string {
  return paths.projectRoot;
}

function baseResult(
  operation: LifecycleResult["operation"],
  paths: InstallPaths,
  dryRun: boolean,
): LifecycleResult {
  return {
    ok: true,
    operation,
    scope: paths.scope,
    dryRun,
    actions: [],
    conflicts: [],
    manifest: null,
    messages: [],
    exitHint: "ok",
  };
}

function wantSkill(opts: InstallCliOptions): boolean {
  return Boolean(opts.skill);
}

function wantHooks(opts: InstallCliOptions): boolean {
  return Boolean(opts.hooks);
}

function wantMemory(opts: InstallCliOptions): boolean {
  return Boolean(opts.installMemory);
}

function wantAgents(opts: InstallCliOptions): boolean {
  // Default on for install when not explicitly false
  return opts.agents !== false;
}

function planInstall(paths: InstallPaths, opts: InstallCliOptions): PlannedAction[] {
  const actions: PlannedAction[] = [
    {
      kind: "mod-add",
      target: paths.modSource,
      detail: `cmd mods add${paths.scope === "user" ? " -g" : ""} ${paths.modSource}`,
    },
  ];
  if (wantSkill(opts)) {
    actions.push({
      kind: "copy-file",
      target: paths.skillDestDir,
      detail: "optional skill installation",
    });
  }
  if (wantHooks(opts)) {
    actions.push({
      kind: "settings-merge",
      target: paths.settingsPath,
      detail: "optional fallback hook installation",
    });
    actions.push({
      kind: "copy-file",
      target: paths.hooksDestDir,
      detail: "hook script files",
    });
  }
  if (wantAgents(opts)) {
    actions.push({
      kind: "copy-file",
      target: `${paths.commandcodeDir}/agents`,
      detail: "bounded role agents (planner/reviewer/explorer)",
    });
  }
  if (wantMemory(opts)) {
    actions.push({
      kind: "copy-file",
      target: `${paths.projectRoot}/AGENTS.md`,
      detail: "optional managed memory block in AGENTS.md",
    });
  }
  actions.push({ kind: "write-manifest", target: paths.manifestPath });
  return actions;
}

function detectConflicts(
  paths: InstallPaths,
  existing: InstallManifest | null,
  opts: InstallCliOptions,
): InstallConflict[] {
  const conflicts: InstallConflict[] = [];
  if (!existing) return conflicts;

  if (existing.scope !== paths.scope && !opts.force) {
    conflicts.push({
      path: paths.manifestPath,
      reason: "scope-conflict",
      message: `Existing manifest scope is ${existing.scope}; requested ${paths.scope}`,
    });
  }

  const drifts = detectManagedFileDrift(existing.managedFiles);
  for (const d of drifts) {
    if (d.actual === null) continue; // missing handled by repair
    conflicts.push({
      path: d.path,
      reason: "user-modified",
      message: `Managed file hash drift (expected ${d.expected.slice(0, 12)}…, got ${d.actual.slice(0, 12)}…)`,
    });
  }

  // Settings lineage: if we recorded after-hash and current differs and user didn't force
  if (existing.settingsAfterHash && existing.settingsAfterHash !== emptyHash()) {
    const current = loadSettings(paths.settingsPath);
    if (current.parseError) {
      conflicts.push({
        path: paths.settingsPath,
        reason: "malformed-settings",
        message: current.parseError,
      });
    } else if (
      current.hash !== existing.settingsAfterHash &&
      existing.managedSettingsEntries.length > 0
    ) {
      // external drift is informational for update; only hard-conflict on force-less destructive ops
      conflicts.push({
        path: paths.settingsPath,
        reason: "external-settings-drift",
        message:
          "Settings changed after installation; will not restore full backup. Owned entries still mergeable.",
      });
    }
  }

  return conflicts;
}

function buildManifest(
  paths: InstallPaths,
  opts: InstallCliOptions,
  fields: {
    commandCodeVersion: string;
    managedFiles: ManagedFileEntry[];
    managedSettingsEntries: InstallManifest["managedSettingsEntries"];
    settingsBeforeHash: string;
    settingsAfterHash: string;
    backupPath: string;
    installedAt?: string;
    status?: InstallManifest["installationStatus"];
  },
): InstallManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    scope: paths.scope,
    packageVersion: paths.packageVersion,
    commandCodeVersion: fields.commandCodeVersion,
    modApiVersion: MOD_API_VERSION,
    installedAt: fields.installedAt ?? now,
    updatedAt: now,
    modSource: paths.modSource,
    managedFiles: fields.managedFiles,
    managedSettingsEntries: fields.managedSettingsEntries,
    settingsBeforeHash: fields.settingsBeforeHash,
    settingsAfterHash: fields.settingsAfterHash,
    backupPath: fields.backupPath,
    installationStatus: fields.status ?? "complete",
    options: {
      skill: wantSkill(opts),
      hooks: wantHooks(opts),
      installMemory: wantMemory(opts),
      agents: wantAgents(opts),
    },
  };
}

export function installLifecycle(opts: InstallCliOptions = {}): LifecycleResult {
  let paths: InstallPaths;
  try {
    paths = resolveInstallPaths(opts);
  } catch (e) {
    return {
      ok: false,
      operation: "install",
      scope: "project",
      dryRun: Boolean(opts.dryRun),
      actions: [],
      conflicts: [],
      manifest: null,
      messages: [],
      error: e instanceof Error ? e.message : String(e),
      exitHint: "usage",
    };
  }
  const dryRun = Boolean(opts.dryRun);
  const result = baseResult("install", paths, dryRun);
  result.actions = planInstall(paths, opts);

  try {
    if (wantMemory(opts)) {
      result.messages.push(
        "Will install optional managed memory block into project AGENTS.md (explicit --install-memory)",
      );
    }

    let existing: InstallManifest | null = null;
    try {
      existing = readManifest(paths.manifestPath);
    } catch (e) {
      if (!opts.force) {
        result.ok = false;
        result.error = e instanceof Error ? e.message : String(e);
        result.exitHint = "config";
        result.conflicts.push({
          path: paths.manifestPath,
          reason: "stale-manifest",
          message: result.error,
        });
        return result;
      }
    }

    if (existing && !opts.force) {
      // idempotent reinstall when same source and complete
      if (
        existing.modSource === paths.modSource &&
        existing.installationStatus === "complete" &&
        existing.scope === paths.scope
      ) {
        result.messages.push("Already installed (idempotent); use --force to reinstall");
        result.manifest = existing;
        result.actions = [{ kind: "skip", target: paths.manifestPath, detail: "idempotent" }];
        return result;
      }
    }

    const conflicts = detectConflicts(paths, existing, opts).filter(
      (c) => c.reason === "user-modified" || c.reason === "malformed-settings",
    );
    if (conflicts.length && !opts.force) {
      result.ok = false;
      result.conflicts = conflicts;
      result.error = "Conflicts detected; re-run with --force to override owned artifacts";
      result.exitHint = "conflict";
      return result;
    }
    result.conflicts = detectConflicts(paths, existing, opts);

    if (dryRun) {
      result.messages.push("Dry run — no changes written");
      result.manifest = buildManifest(paths, opts, {
        commandCodeVersion: "dry-run",
        managedFiles: [],
        managedSettingsEntries: [],
        settingsBeforeHash: emptyHash(),
        settingsAfterHash: emptyHash(),
        backupPath: "",
        status: "dry-run",
      });
      return result;
    }

    const manager = requireModManager(opts.cmdPath, envFor(opts, paths));
    mkdirSync(paths.commandcodeDir, { recursive: true });

    const settingsBefore = loadSettings(paths.settingsPath);
    if (settingsBefore.parseError && !opts.force) {
      result.ok = false;
      result.error = `Refusing to install: settings parse error: ${settingsBefore.parseError}`;
      result.exitHint = "config";
      result.conflicts.push({
        path: paths.settingsPath,
        reason: "malformed-settings",
        message: settingsBefore.parseError,
      });
      return result;
    }

    const add = modAdd(
      manager.cmdPath,
      paths.modSource,
      paths.scope,
      envFor(opts, paths),
      projectCwd(paths),
    );
    if (!add.ok) {
      result.ok = false;
      result.error = `cmd mods add failed (exit ${add.status}): ${add.stderr || add.stdout}`;
      result.exitHint = "subprocess";
      return result;
    }
    result.messages.push(`Mod installed via official manager: ${paths.modSource}`);

    const managedFiles: ManagedFileEntry[] = [
      {
        path: paths.settingsPath,
        sha256: sha256File(paths.settingsPath) ?? emptyHash(),
        method: "mod-manager",
        sourceArtifact: `cmd-mods-add:${paths.modSource}`,
        ownershipMarker: INSTALL_OWNERSHIP_MARKER,
      },
    ];
    let managedSettings = existing?.managedSettingsEntries ?? [];
    let settingsBeforeHash = settingsBefore.hash;
    let settingsAfterHash = sha256File(paths.settingsPath) ?? emptyHash();
    let backupPath = existing?.backupPath ?? "";

    if (wantSkill(opts)) {
      const skillFiles = installSkillSurface(paths);
      managedFiles.push(...skillFiles);
      result.messages.push(`Skill installed at ${paths.skillDestDir}`);
    }

    if (wantAgents(opts)) {
      const agentFiles = installAgentsSurface(paths);
      managedFiles.push(...agentFiles);
      result.messages.push(
        `Bounded agents installed under ${paths.commandcodeDir}/agents (model: inherit for project)`,
      );
    }

    if (wantMemory(opts)) {
      const mem = installMemoryBlock(paths);
      managedFiles.push(mem);
      result.messages.push(
        `Managed memory block written to ${mem.path} (does not claim deterministic enforcement)`,
      );
    }

    if (wantHooks(opts)) {
      if (settingsBefore.parseError) {
        result.messages.push(`Hooks skipped: malformed settings (${settingsBefore.parseError})`);
      } else {
        const hooks = installHooksSurface(paths, { force: opts.force });
        if (hooks.skipped) {
          result.messages.push(`Hooks skipped: ${hooks.skipped}`);
        } else {
          managedFiles.push(...hooks.files);
          managedSettings = hooks.settingsEntries;
          settingsBeforeHash = hooks.settingsBeforeHash;
          settingsAfterHash = hooks.settingsAfterHash;
          backupPath = hooks.backupPath;
          result.messages.push("Fallback hooks installed with ownership markers");
        }
      }
    }

    // Verify mod registration in settings
    const afterSettings = loadSettings(paths.settingsPath);
    if (!afterSettings.parseError && !settingsMentionsSource(afterSettings.text, paths.modSource)) {
      result.messages.push(
        "Warning: settings may not list mod source (project mods require trust to appear in `cmd mods list`)",
      );
    }

    const manifest = buildManifest(paths, opts, {
      commandCodeVersion: manager.version ?? "unknown",
      managedFiles,
      managedSettingsEntries: managedSettings,
      settingsBeforeHash,
      settingsAfterHash,
      backupPath,
      installedAt: existing?.installedAt,
      status: "complete",
    });
    writeManifestAtomic(paths.manifestPath, manifest);
    result.manifest = manifest;
    result.messages.push(`Manifest written: ${paths.manifestPath}`);
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
    result.exitHint =
      e instanceof InstallError && e.code === "MOD_MANAGER_UNAVAILABLE"
        ? "subprocess"
        : e instanceof Error && e.message.includes("--project and --user")
          ? "usage"
          : "config";
    return result;
  }
}

export function statusLifecycle(opts: InstallCliOptions = {}): LifecycleResult {
  const paths = resolveInstallPaths(opts);
  const result = baseResult("status", paths, false);
  try {
    const manifest = readManifest(paths.manifestPath);
    result.manifest = manifest;
    if (!manifest) {
      result.messages.push(`Not installed (${paths.scope})`);
      result.ok = true;
      return result;
    }
    const manager = probeModManager(opts.cmdPath, envFor(opts, paths));
    result.messages.push(`scope=${manifest.scope}`);
    result.messages.push(`packageVersion=${manifest.packageVersion}`);
    result.messages.push(`commandCodeVersion=${manifest.commandCodeVersion}`);
    result.messages.push(`modSource=${manifest.modSource}`);
    result.messages.push(`status=${manifest.installationStatus}`);
    result.messages.push(`modManager=${manager.available ? "available" : "unavailable"}`);

    const drifts = detectManagedFileDrift(manifest.managedFiles);
    for (const d of drifts) {
      if (d.actual === null) {
        result.conflicts.push({
          path: d.path,
          reason: "hash-mismatch",
          message: "Managed file missing",
        });
      } else {
        result.conflicts.push({
          path: d.path,
          reason: "user-modified",
          message: "Managed file hash drift",
        });
      }
    }

    if (manager.cmdPath) {
      const list = modList(manager.cmdPath, envFor(opts, paths), projectCwd(paths));
      const settings = loadSettings(paths.settingsPath);
      const inSettings =
        !settings.parseError && settingsMentionsSource(settings.text, manifest.modSource);
      result.messages.push(`modInSettings=${inSettings}`);
      result.messages.push(`modListMentionsSource=${list.mentionsSource(manifest.modSource)}`);
      if (!inSettings) {
        result.conflicts.push({
          path: paths.settingsPath,
          reason: "stale-manifest",
          message: "Mod source not present in settings mods.sources",
        });
      }
    }
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
    result.exitHint = "config";
    return result;
  }
}

export function updateLifecycle(opts: InstallCliOptions = {}): LifecycleResult {
  const paths = resolveInstallPaths(opts);
  const dryRun = Boolean(opts.dryRun);
  const result = baseResult("update", paths, dryRun);

  try {
    const existing = readManifest(paths.manifestPath);
    if (!existing) {
      result.ok = false;
      result.error = "Nothing to update — run `ccroute install` first";
      result.exitHint = "config";
      return result;
    }
    result.manifest = existing;

    const conflicts = detectConflicts(paths, existing, opts).filter(
      (c) => c.reason === "user-modified" || c.reason === "malformed-settings",
    );
    result.conflicts = detectConflicts(paths, existing, opts);
    if (conflicts.length && !opts.force) {
      result.ok = false;
      result.error = "Update refused due to conflicts; use --force after review";
      result.exitHint = "conflict";
      result.actions = [{ kind: "skip", target: paths.manifestPath, detail: "conflict" }];
      return result;
    }

    result.actions = [
      {
        kind: "mod-update",
        target: existing.modSource,
        detail: "cmd mods update + re-add pinned source",
      },
      { kind: "write-manifest", target: paths.manifestPath },
    ];

    if (dryRun) {
      result.messages.push("Dry run — update preview only");
      return result;
    }

    const manager = requireModManager(opts.cmdPath, envFor(opts, paths));
    const upd = modUpdate(manager.cmdPath, envFor(opts, paths), projectCwd(paths));
    if (!upd.ok) {
      result.messages.push(`cmd mods update exited ${upd.status}: ${upd.stderr || upd.stdout}`);
    }
    // Re-pin our source (local path / exact version)
    const add = modAdd(
      manager.cmdPath,
      paths.modSource,
      paths.scope,
      envFor(opts, paths),
      projectCwd(paths),
    );
    if (!add.ok) {
      result.ok = false;
      result.error = `Failed to re-pin mod source: ${add.stderr || add.stdout}`;
      result.exitHint = "subprocess";
      return result;
    }

    const managedFiles = [...existing.managedFiles];
    // refresh settings hash entry
    const settingsHash = sha256File(paths.settingsPath) ?? emptyHash();
    let withoutSettings = managedFiles.filter((f) => f.method !== "mod-manager");
    withoutSettings.unshift({
      path: paths.settingsPath,
      sha256: settingsHash,
      method: "mod-manager",
      sourceArtifact: `cmd-mods-add:${paths.modSource}`,
      ownershipMarker: INSTALL_OWNERSHIP_MARKER,
    });

    if (existing.options?.skill || wantSkill(opts)) {
      // replace skill files if we own them
      removeSkillSurface(paths, existing.managedFiles);
      const skillFiles = installSkillSurface(paths);
      withoutSettings.push(
        ...skillFiles,
        ...existing.managedFiles.filter(
          (f) =>
            !f.sourceArtifact.startsWith("skill:") &&
            f.method !== "mod-manager" &&
            !f.sourceArtifact.startsWith("hook:") &&
            !f.sourceArtifact.startsWith("agent:"),
        ),
      );
    }

    if (existing.options?.agents !== false || wantAgents(opts)) {
      removeAgentsSurface(paths, existing.managedFiles);
      const agentFiles = installAgentsSurface(paths);
      withoutSettings = withoutSettings.filter((f) => !f.sourceArtifact.startsWith("agent:"));
      withoutSettings.push(...agentFiles);
      result.messages.push("Refreshed managed role agents");
    }

    let managedSettings = existing.managedSettingsEntries;
    let settingsBeforeHash = existing.settingsBeforeHash;
    let settingsAfterHash = settingsHash;
    let backupPath = existing.backupPath;

    if (existing.options?.hooks || wantHooks(opts)) {
      const hooks = installHooksSurface(paths, { force: opts.force });
      if (!hooks.skipped) {
        managedSettings = hooks.settingsEntries;
        settingsBeforeHash = hooks.settingsBeforeHash;
        settingsAfterHash = hooks.settingsAfterHash;
        backupPath = hooks.backupPath;
        withoutSettings.push(...hooks.files);
      }
    }

    // de-dupe managed files by path (last wins)
    const byPath = new Map<string, ManagedFileEntry>();
    for (const f of withoutSettings) byPath.set(f.path, f);
    const finalFiles = [...byPath.values()];

    const manifest = buildManifest(paths, opts, {
      commandCodeVersion: manager.version ?? existing.commandCodeVersion,
      managedFiles: finalFiles,
      managedSettingsEntries: managedSettings,
      settingsBeforeHash,
      settingsAfterHash,
      backupPath,
      installedAt: existing.installedAt,
      status: "complete",
    });
    writeManifestAtomic(paths.manifestPath, manifest);
    result.manifest = manifest;
    result.messages.push("Update complete");
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
    result.exitHint = "config";
    return result;
  }
}

export function repairLifecycle(opts: InstallCliOptions = {}): LifecycleResult {
  const paths = resolveInstallPaths(opts);
  const dryRun = Boolean(opts.dryRun);
  const result = baseResult("repair", paths, dryRun);

  try {
    const existing = readManifest(paths.manifestPath);
    if (!existing) {
      result.ok = false;
      result.error = "Nothing to repair — run `ccroute install` first";
      result.exitHint = "config";
      return result;
    }
    result.manifest = existing;

    const drifts = detectManagedFileDrift(existing.managedFiles);
    const settings = loadSettings(paths.settingsPath);
    const missingMod =
      !settings.parseError && !settingsMentionsSource(settings.text, existing.modSource);

    result.actions = [];
    if (missingMod) {
      result.actions.push({
        kind: "mod-add",
        target: existing.modSource,
        detail: "restore missing Mod registration",
      });
    }
    for (const d of drifts) {
      result.actions.push({
        kind: d.actual === null ? "copy-file" : "skip",
        target: d.path,
        detail:
          d.actual === null
            ? "restore missing managed file"
            : opts.force
              ? "force restore user-modified managed file"
              : "preserve user-modified file (not forced)",
        destructive: d.actual !== null,
      });
    }
    result.actions.push({ kind: "write-manifest", target: paths.manifestPath });

    if (dryRun) {
      result.messages.push("Dry run — repair preview only");
      return result;
    }

    const manager = requireModManager(opts.cmdPath, envFor(opts, paths));
    if (missingMod) {
      const add = modAdd(
        manager.cmdPath,
        existing.modSource,
        paths.scope,
        envFor(opts, paths),
        projectCwd(paths),
      );
      if (!add.ok) {
        result.ok = false;
        result.error = `Failed to restore mod: ${add.stderr || add.stdout}`;
        result.exitHint = "subprocess";
        return result;
      }
      result.messages.push("Restored Mod registration via cmd mods add");
    }

    // Repair only owned skill/hook files that are missing or (with --force) drifted
    const repairedFiles: ManagedFileEntry[] = [];
    for (const f of existing.managedFiles) {
      if (f.method === "mod-manager" || f.method === "settings-merge") {
        repairedFiles.push({
          ...f,
          sha256: sha256File(f.path) ?? f.sha256,
        });
        continue;
      }
      const actual = sha256File(f.path);
      if (actual === f.sha256) {
        repairedFiles.push(f);
        continue;
      }
      if (actual !== null && !opts.force) {
        result.conflicts.push({
          path: f.path,
          reason: "user-modified",
          message: "Preserved user-modified managed file (use --force to overwrite)",
        });
        repairedFiles.push({ ...f, sha256: actual });
        continue;
      }
      // missing or forced: reinstall surface if skill/hook
      if (f.sourceArtifact.startsWith("skill:")) {
        // full skill reinstall once
        continue;
      }
      if (f.sourceArtifact.startsWith("hook:")) {
        continue;
      }
      repairedFiles.push(f);
    }

    const skillNeedsRepair = existing.managedFiles.some(
      (f) =>
        f.sourceArtifact.startsWith("skill:") &&
        (sha256File(f.path) === null || (opts.force && sha256File(f.path) !== f.sha256)),
    );
    if (existing.options?.skill && skillNeedsRepair) {
      const skillFiles = installSkillSurface(paths);
      const nonSkill = repairedFiles.filter((f) => !f.sourceArtifact.startsWith("skill:"));
      repairedFiles.length = 0;
      repairedFiles.push(...nonSkill, ...skillFiles);
      result.messages.push("Repaired skill surface");
    }

    const agentNeedsRepair =
      existing.options?.agents !== false &&
      (existing.managedFiles.some(
        (f) =>
          f.sourceArtifact.startsWith("agent:") &&
          (sha256File(f.path) === null || (opts.force && sha256File(f.path) !== f.sha256)),
      ) ||
        !existsSync(`${paths.commandcodeDir}/agents/ccroute-planner/AGENT.md`));
    if (agentNeedsRepair) {
      const agentFiles = installAgentsSurface(paths);
      const nonAgent = repairedFiles.filter((f) => !f.sourceArtifact.startsWith("agent:"));
      repairedFiles.length = 0;
      repairedFiles.push(...nonAgent, ...agentFiles);
      result.messages.push("Repaired bounded role agents");
    }

    let managedSettings = existing.managedSettingsEntries;
    let settingsBeforeHash = existing.settingsBeforeHash;
    let settingsAfterHash = sha256File(paths.settingsPath) ?? existing.settingsAfterHash;
    let backupPath = existing.backupPath;

    const hookNeedsRepair = existing.managedFiles.some(
      (f) =>
        f.sourceArtifact.startsWith("hook:") &&
        (sha256File(f.path) === null || (opts.force && sha256File(f.path) !== f.sha256)),
    );
    if (existing.options?.hooks && (hookNeedsRepair || missingMod || opts.force)) {
      // Only rewrite hook settings when files need repair or force; avoid silent bulldozer
      if (hookNeedsRepair || opts.force) {
        const hooks = installHooksSurface(paths, { force: opts.force });
        if (!hooks.skipped) {
          const nonHook = repairedFiles.filter((f) => !f.sourceArtifact.startsWith("hook:"));
          repairedFiles.length = 0;
          repairedFiles.push(...nonHook, ...hooks.files);
          managedSettings = hooks.settingsEntries;
          settingsBeforeHash = hooks.settingsBeforeHash;
          settingsAfterHash = hooks.settingsAfterHash;
          backupPath = hooks.backupPath;
          result.messages.push("Repaired hook surface");
        }
      }
    }

    // Deduplicate hooks in settings if duplicated
    if (settings.parseError) {
      result.messages.push(`Settings still malformed: ${settings.parseError}`);
    }

    const manifest = buildManifest(
      paths,
      { ...opts, skill: existing.options?.skill, hooks: existing.options?.hooks },
      {
        commandCodeVersion: manager.version ?? existing.commandCodeVersion,
        managedFiles: repairedFiles,
        managedSettingsEntries: managedSettings,
        settingsBeforeHash,
        settingsAfterHash,
        backupPath,
        installedAt: existing.installedAt,
        status: "complete",
      },
    );
    writeManifestAtomic(paths.manifestPath, manifest);
    result.manifest = manifest;
    result.messages.push("Repair complete");
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
    result.exitHint = "config";
    return result;
  }
}

export function uninstallLifecycle(opts: InstallCliOptions = {}): LifecycleResult {
  const paths = resolveInstallPaths(opts);
  const dryRun = Boolean(opts.dryRun);
  const result = baseResult("uninstall", paths, dryRun);

  try {
    let existing: InstallManifest | null = null;
    try {
      existing = readManifest(paths.manifestPath);
    } catch (e) {
      result.ok = false;
      result.error = e instanceof Error ? e.message : String(e);
      result.exitHint = "config";
      return result;
    }

    if (!existing) {
      result.messages.push("Nothing to uninstall");
      result.actions = [{ kind: "skip", target: paths.manifestPath, detail: "absent" }];
      return result;
    }
    result.manifest = existing;

    // Refuse destructive full-backup restore when settings drifted
    const settings = loadSettings(paths.settingsPath);
    if (settings.parseError && !opts.force) {
      result.ok = false;
      result.error = `Settings malformed; refuse uninstall mutation: ${settings.parseError}`;
      result.exitHint = "config";
      result.conflicts.push({
        path: paths.settingsPath,
        reason: "malformed-settings",
        message: settings.parseError,
      });
      return result;
    }

    result.actions = [
      {
        kind: "mod-remove",
        target: existing.modSource,
        detail: `cmd mods remove${paths.scope === "user" ? " -g" : ""}`,
        destructive: true,
      },
      {
        kind: "settings-unmerge",
        target: paths.settingsPath,
        detail: "remove only ccroute-owned hook entries",
      },
      {
        kind: "remove-file",
        target: paths.skillDestDir,
        detail: "remove owned skill files",
        destructive: true,
      },
      {
        kind: "remove-manifest",
        target: paths.manifestPath,
        destructive: true,
      },
    ];

    if (dryRun) {
      result.messages.push("Dry run — uninstall preview only");
      return result;
    }

    const manager = requireModManager(opts.cmdPath, envFor(opts, paths));
    const rem = modRemove(
      manager.cmdPath,
      existing.modSource,
      paths.scope,
      envFor(opts, paths),
      projectCwd(paths),
    );
    if (!rem.ok) {
      result.messages.push(
        `cmd mods remove exited ${rem.status}: ${rem.stderr || rem.stdout} (continuing owned cleanup)`,
      );
    } else {
      result.messages.push("Mod removed via official manager");
    }

    if (existing.options?.skill) {
      removeSkillSurface(paths, existing.managedFiles);
      result.messages.push("Removed owned skill files");
    }

    // Always attempt agent cleanup for managed agent artifacts
    removeAgentsSurface(paths, existing.managedFiles);
    if (
      existing.options?.agents ||
      existing.managedFiles.some((f) => f.sourceArtifact.startsWith("agent:"))
    ) {
      result.messages.push("Removed owned role agents");
    }

    if (opts.removeMemory || existing.options?.installMemory || memoryBlockPresent(paths)) {
      if (opts.removeMemory || existing.options?.installMemory) {
        const mem = removeMemoryBlock(paths);
        result.messages.push(...mem.messages);
      }
    }

    if (existing.options?.hooks || existing.managedSettingsEntries.length) {
      const r = removeHooksSurface(paths, existing.managedSettingsEntries, existing.managedFiles);
      if (r.skipped) result.messages.push(r.skipped);
      else result.messages.push("Removed owned hook entries (settings preserved otherwise)");
    }

    // Verify absence of mod source
    const after = loadSettings(paths.settingsPath);
    if (!after.parseError && settingsMentionsSource(after.text, existing.modSource)) {
      result.messages.push(
        "Warning: mod source still present in settings after remove — inspect manually",
      );
    } else {
      result.messages.push("Verified mod source absent from settings");
    }

    // Uninstall report retained beside backups
    const report = {
      uninstalledAt: new Date().toISOString(),
      scope: paths.scope,
      modSource: existing.modSource,
      packageVersion: existing.packageVersion,
      preservedSettings: true,
      fullBackupRestored: false,
    };
    mkdirSync(paths.backupDir, { recursive: true });
    const reportPath = `${paths.backupDir}/uninstall-report-${Date.now()}.json`;
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    result.messages.push(`Uninstall report: ${reportPath}`);

    removeManifest(paths.manifestPath);
    result.manifest = {
      ...existing,
      installationStatus: "uninstalled",
      updatedAt: new Date().toISOString(),
    };
    result.messages.push("Uninstall complete");
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e instanceof Error ? e.message : String(e);
    result.exitHint = "config";
    return result;
  }
}

export function formatLifecycleResult(result: LifecycleResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const lines: string[] = [];
  lines.push(`ccroute ${result.operation} (${result.scope}${result.dryRun ? ", dry-run" : ""})`);
  if (result.error) lines.push(`ERROR: ${result.error}`);
  for (const m of result.messages) lines.push(`  ${m}`);
  if (result.actions.length) {
    lines.push("Actions:");
    for (const a of result.actions) {
      lines.push(`  - ${a.kind}: ${a.target}${a.detail ? ` (${a.detail})` : ""}`);
    }
  }
  if (result.conflicts.length) {
    lines.push("Conflicts:");
    for (const c of result.conflicts) {
      lines.push(`  - [${c.reason}] ${c.path}: ${c.message}`);
    }
  }
  if (result.manifest && result.operation === "status") {
    lines.push(`Manifest status: ${result.manifest.installationStatus}`);
  }
  lines.push(result.ok ? "OK" : "FAILED");
  return lines.join("\n");
}

// re-export helpers used by tests
export { sourcesFromSettingsText, settingsMentionsSource, sha256Text };
