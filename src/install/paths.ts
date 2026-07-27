import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { packageRoot as defaultPackageRoot } from "../config/defaults.js";
import { type InstallCliOptions, type InstallScope, MANIFEST_FILENAME } from "./types.js";

export interface InstallPaths {
  scope: InstallScope;
  projectRoot: string;
  homeDir: string;
  packageRoot: string;
  scopeRoot: string;
  commandcodeDir: string;
  settingsPath: string;
  manifestPath: string;
  skillDestDir: string;
  hooksDestDir: string;
  backupDir: string;
  modSource: string;
  skillSourceDir: string;
  hooksSourceDir: string;
  packageVersion: string;
}

export function resolveScope(opts: InstallCliOptions): InstallScope {
  if (opts.project && opts.user) {
    throw new Error("Reject simultaneous --project and --user; choose exactly one scope");
  }
  if (opts.user) return "user";
  return "project";
}

export function resolvePackageVersion(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Prefer the dedicated Mod package directory (has commandcode.mods + index.ts).
 * Fall back to package root when that directory is published under package files.
 */
export function resolveModSource(packageRootPath: string, override?: string): string {
  if (override) return resolve(override);

  const candidates = [
    join(packageRootPath, "src/integrations/commandcode-mod"),
    join(packageRootPath, "integrations/commandcode-mod"),
    packageRootPath,
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "package.json")) || existsSync(join(c, "index.ts"))) {
      // Prefer directory that declares commandcode.mods when available
      try {
        const pkg = JSON.parse(readFileSync(join(c, "package.json"), "utf8")) as {
          commandcode?: { mods?: unknown };
        };
        if (pkg.commandcode?.mods || existsSync(join(c, "index.ts"))) {
          return resolve(c);
        }
      } catch {
        if (existsSync(join(c, "index.ts"))) return resolve(c);
      }
    }
  }
  return resolve(packageRootPath);
}

export function resolveInstallPaths(opts: InstallCliOptions = {}): InstallPaths {
  const scope = resolveScope(opts);
  const projectRoot = resolve(opts.projectRoot ?? process.cwd());
  const homeDir = resolve(opts.homeDir ?? opts.env?.HOME ?? homedir());
  const pkgRoot = resolve(opts.packageRoot ?? defaultPackageRoot());
  const packageVersion = resolvePackageVersion(pkgRoot);

  const scopeRoot = scope === "project" ? projectRoot : homeDir;
  const commandcodeDir = join(scopeRoot, ".commandcode");
  const settingsPath = join(commandcodeDir, "settings.json");
  const manifestPath = join(commandcodeDir, MANIFEST_FILENAME);
  const skillDestDir = join(commandcodeDir, "skills", "commandcode-deal-orchestrator");
  const hooksDestDir = join(commandcodeDir, "ccroute-hooks");
  const backupDir = join(commandcodeDir, "ccroute-backups");

  const skillSourceDir = join(pkgRoot, "skills", "commandcode-deal-orchestrator");
  const hooksSourceDir = join(pkgRoot, "hooks");

  return {
    scope,
    projectRoot,
    homeDir,
    packageRoot: pkgRoot,
    scopeRoot,
    commandcodeDir,
    settingsPath,
    manifestPath,
    skillDestDir,
    hooksDestDir,
    backupDir,
    modSource: resolveModSource(pkgRoot, opts.modSource),
    skillSourceDir,
    hooksSourceDir,
    packageVersion,
  };
}
