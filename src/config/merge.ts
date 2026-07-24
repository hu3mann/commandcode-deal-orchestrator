import { type RoutingConfig, SECURITY_SENSITIVE_KEYS } from "./schemas.js";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  path = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const p = path ? `${path}.${key}` : key;
    if (SECURITY_SENSITIVE_KEYS.has(key) && !(key in base) && path.includes("security")) {
      throw new ConfigError(`Unknown security-sensitive key rejected: ${p}`);
    }
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value, p);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function mergeConfigs(
  defaults: RoutingConfig,
  user?: Partial<RoutingConfig> | Record<string, unknown>,
  project?: Partial<RoutingConfig> | Record<string, unknown>,
  cli?: Partial<RoutingConfig> | Record<string, unknown>,
): Record<string, unknown> {
  let acc: Record<string, unknown> = structuredClone(defaults) as unknown as Record<
    string,
    unknown
  >;
  if (user) acc = deepMerge(acc, user as Record<string, unknown>);
  if (project) acc = deepMerge(acc, project as Record<string, unknown>);
  if (cli) acc = deepMerge(acc, cli as Record<string, unknown>);
  return acc;
}
