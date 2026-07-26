import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadDefaultRoutingConfig } from "./defaults.js";
import { ConfigError, mergeConfigs } from "./merge.js";
import { type RoutingConfig, RoutingConfigSchema } from "./schemas.js";

export interface LoadedConfig {
  config: RoutingConfig;
  paths: {
    defaults: string;
    user?: string;
    project?: string;
  };
  sources: string[];
}

export function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

export function userConfigPath(): string {
  return join(homedir(), ".commandcode", "deal-router.yaml");
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, ".commandcode", "deal-router.yaml");
}

export function stateDir(): string {
  return join(homedir(), ".commandcode", "deal-router");
}

function readYamlIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = parseYaml(readFileSync(path, "utf8"));
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new ConfigError(`Malformed YAML (expected mapping): ${path}`);
    }
    return raw as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Failed to parse config ${path}: ${(e as Error).message}`);
  }
}

export function loadConfig(options?: {
  cwd?: string;
  cliOverrides?: Record<string, unknown>;
  /**
   * `--config <path>` (see src/cli.ts): an explicit config file the user pointed at on
   * the command line. Unlike project-scope config (<cwd>/.commandcode/deal-router.yaml,
   * which is untrusted because it travels with a repo checkout — see
   * PROJECT_FORBIDDEN_KEYS in schemas.ts), a path supplied via an explicit CLI flag is the
   * operator's own stated intent, so it is merged at USER trust level (cmdPath etc. are
   * permitted) rather than at project trust level. It fully replaces the normal
   * user-config + project-config file discovery for this invocation — the user asked for
   * *this* file, not for the usual search path.
   *
   * Must exist: an explicitly-named config file that is missing is fail-closed (a typo'd
   * --config path silently falling back to defaults would be worse than refusing to run).
   */
  explicitConfigPath?: string;
}): LoadedConfig {
  const cwd = options?.cwd ?? process.cwd();
  const defaults = loadDefaultRoutingConfig();

  if (options?.explicitConfigPath) {
    const explicit = readYamlIfExists(options.explicitConfigPath);
    if (explicit === undefined) {
      throw new ConfigError(`Config file not found: ${options.explicitConfigPath}`);
    }
    const merged = mergeConfigs(defaults, explicit, undefined, options?.cliOverrides);
    const parsed = RoutingConfigSchema.safeParse(merged);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ConfigError(`Configuration invalid (fail-closed): ${msg}`);
    }
    const sources = ["built-in defaults", options.explicitConfigPath];
    if (options?.cliOverrides && Object.keys(options.cliOverrides).length > 0) {
      sources.push("CLI flags");
    }
    return {
      config: parsed.data,
      paths: {
        defaults: "config/routing.default.yaml",
        user: options.explicitConfigPath,
      },
      sources,
    };
  }

  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd);
  const user = readYamlIfExists(userPath);
  const project = readYamlIfExists(projectPath);

  // Project config must fail closed if present and invalid after merge parse
  const merged = mergeConfigs(defaults, user, project, options?.cliOverrides);

  const parsed = RoutingConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    // If project file exists, always fail closed
    if (project !== undefined) {
      throw new ConfigError(`Project configuration invalid (fail-closed): ${msg}`);
    }
    throw new ConfigError(`Configuration invalid: ${msg}`);
  }

  const sources = ["built-in defaults"];
  if (user) sources.push(userPath);
  if (project) sources.push(projectPath);
  if (options?.cliOverrides && Object.keys(options.cliOverrides).length > 0) {
    sources.push("CLI flags");
  }

  return {
    config: parsed.data,
    paths: {
      defaults: "config/routing.default.yaml",
      ...(user ? { user: userPath } : {}),
      ...(project ? { project: projectPath } : {}),
    },
    sources,
  };
}

export function validateConfigFile(path: string): { ok: true } | { ok: false; error: string } {
  try {
    const raw = readYamlIfExists(path);
    if (raw === undefined) return { ok: false, error: `File not found: ${path}` };
    const defaults = loadDefaultRoutingConfig();
    const merged = mergeConfigs(defaults, raw);
    const parsed = RoutingConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
