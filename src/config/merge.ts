import { PROJECT_FORBIDDEN_KEYS, type RoutingConfig, SECURITY_SENSITIVE_KEYS } from "./schemas.js";

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
    // NOTE: this check intentionally applies at every nesting level, including the
    // top level (path === ""). It previously required `path.includes("security")`,
    // which meant a security-sensitive key smuggled in at the top of a config file
    // (e.g. `{ apiKey: "..." }` or `{ shell: true }` outside the `security:` block)
    // was never checked. The key is still only rejected when it is not already a
    // legitimate field of the object being merged into (`!(key in base)`), so real
    // schema fields under `security:` are unaffected.
    if (SECURITY_SENSITIVE_KEYS.has(key) && !(key in base)) {
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

/**
 * Reject keys that project-scope config is not allowed to set (see
 * PROJECT_FORBIDDEN_KEYS in schemas.ts for rationale). Only checks the top-level
 * project object: these keys are all top-level RoutingConfig fields today, and a
 * project file is untrusted regardless of nesting, so this fails closed on any
 * project config that defines them.
 */
function assertNoProjectForbiddenKeys(project: Record<string, unknown>): void {
  for (const key of Object.keys(project)) {
    if (PROJECT_FORBIDDEN_KEYS.has(key)) {
      throw new ConfigError(
        `Key '${key}' is not allowed in project-scope config (.commandcode/deal-router.yaml). Set it in user-scope config (~/.commandcode/deal-router.yaml) instead.`,
      );
    }
  }
}

export function mergeConfigs(
  defaults: RoutingConfig,
  user?: Partial<RoutingConfig> | Record<string, unknown>,
  project?: Partial<RoutingConfig> | Record<string, unknown>,
  cli?: Partial<RoutingConfig> | Record<string, unknown>,
): Record<string, unknown> {
  if (project) assertNoProjectForbiddenKeys(project as Record<string, unknown>);
  let acc: Record<string, unknown> = structuredClone(defaults) as unknown as Record<
    string,
    unknown
  >;
  if (user) acc = deepMerge(acc, user as Record<string, unknown>);
  if (project) acc = deepMerge(acc, project as Record<string, unknown>);
  if (cli) acc = deepMerge(acc, cli as Record<string, unknown>);
  return acc;
}
