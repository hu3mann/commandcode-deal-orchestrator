/**
 * Thin wrapper over CommandCode's official Mod manager.
 * Never recreates CommandCode's registry manually.
 */

import { spawnSync } from "node:child_process";
import { resolveCmdPath, runCmdCapture } from "../discovery/commandcode-cli.js";
import type { InstallScope } from "./types.js";
import { InstallError } from "./types.js";

export interface ModManagerProbe {
  available: boolean;
  cmdPath: string | null;
  version: string | null;
  hasModsCommand: boolean;
  error?: string;
}

export interface ModListResult {
  raw: string;
  status: number | null;
  sources: string[];
  mentionsSource: (source: string) => boolean;
}

export function probeModManager(
  cmdPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ModManagerProbe {
  // Prefer an explicit path when it actually runs (tests inject a fake `cmd`).
  // Otherwise fall back to the hardened PATH-first resolver used elsewhere.
  let path: string | null = null;
  if (cmdPath === null) {
    path = null;
  } else if (cmdPath) {
    const direct = runCmdCapture(cmdPath, ["--version"], { env, timeoutMs: 5_000 });
    path = direct.status === 0 ? cmdPath : resolveCmdPath(cmdPath, env);
  } else {
    path = resolveCmdPath(undefined, env);
  }
  if (!path) {
    return {
      available: false,
      cmdPath: null,
      version: null,
      hasModsCommand: false,
      error: "CommandCode `cmd` executable not found",
    };
  }
  const ver = runCmdCapture(path, ["--version"], { env });
  const version = (ver.stdout || ver.stderr).trim() || null;
  const help = runCmdCapture(path, ["mods", "--help"], { env });
  const helpText = `${help.stdout}\n${help.stderr}`;
  const hasModsCommand = help.status === 0 && /mods add|Install a mod|Manage mods/i.test(helpText);
  return {
    available: hasModsCommand,
    cmdPath: path,
    version,
    hasModsCommand,
    error: hasModsCommand ? undefined : "cmd mods manager unavailable",
  };
}

function runMods(
  cmdPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmdPath, args, {
    encoding: "utf8",
    shell: false,
    env,
    cwd,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

export function modAdd(
  cmdPath: string,
  source: string,
  scope: InstallScope,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const args = ["mods", "add"];
  if (scope === "user") args.push("-g");
  args.push(source);
  const r = runMods(cmdPath, args, env, cwd);
  return {
    ok: r.status === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    status: r.status,
  };
}

export function modRemove(
  cmdPath: string,
  source: string,
  scope: InstallScope,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const args = ["mods", "remove"];
  if (scope === "user") args.push("-g");
  args.push(source);
  const r = runMods(cmdPath, args, env, cwd);
  return {
    ok: r.status === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    status: r.status,
  };
}

export function modUpdate(
  cmdPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = runMods(cmdPath, ["mods", "update"], env, cwd);
  return {
    ok: r.status === 0,
    stdout: r.stdout,
    stderr: r.stderr,
    status: r.status,
  };
}

export function modList(
  cmdPath: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): ModListResult {
  const r = runMods(cmdPath, ["mods", "list"], env, cwd);
  const raw = `${r.stdout}\n${r.stderr}`;
  // Local sources appear as absolute paths in settings and sometimes in list output
  const sources: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/local:(\S+)/);
    if (m) sources.push(m[1]!);
    const pathish = line.match(/(\/[^\s]+commandcode-mod[^\s]*)/);
    if (pathish) sources.push(pathish[1]!);
  }
  return {
    raw,
    status: r.status,
    sources,
    mentionsSource(source: string) {
      const norm = source.replace(/\/$/, "");
      return (
        raw.includes(source) ||
        raw.includes(norm) ||
        sources.some((s) => s === source || s === norm || s.includes(norm))
      );
    },
  };
}

/** Read mods.sources from a settings file body. */
export function sourcesFromSettingsText(text: string): string[] {
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text) as { mods?: { sources?: unknown } };
    const sources = data.mods?.sources;
    if (!Array.isArray(sources)) return [];
    return sources.map((s) => {
      if (typeof s === "string") return s;
      if (s && typeof s === "object" && "source" in s) {
        return String((s as { source: unknown }).source);
      }
      return String(s);
    });
  } catch {
    return [];
  }
}

export function settingsMentionsSource(text: string, source: string): boolean {
  const sources = sourcesFromSettingsText(text);
  const norm = source.replace(/\/$/, "");
  return sources.some(
    (s) => s === source || s === norm || s.replace(/\/$/, "") === norm || s.includes(norm),
  );
}

export function requireModManager(
  cmdPath?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ModManagerProbe & { cmdPath: string } {
  const probe = probeModManager(cmdPath, env);
  if (!probe.available || !probe.cmdPath) {
    throw new InstallError(
      "MOD_MANAGER_UNAVAILABLE",
      probe.error ?? "CommandCode mod manager is not available",
    );
  }
  return probe as ModManagerProbe & { cmdPath: string };
}
