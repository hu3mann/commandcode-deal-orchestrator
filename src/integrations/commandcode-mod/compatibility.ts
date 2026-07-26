import {
  COMPAT_MIN_COMMANDCODE,
  type CompatibilityReport,
  MOD_API_VERSION,
  type ModApi,
} from "./types.js";

const REQUIRED_METHODS = ["hooks", "addCommand", "setModel", "on", "ui"] as const;

const OPTIONAL_METHODS = ["setEffort", "showEntry", "exec"] as const;

function parseSemver(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const m = String(v)
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isVersionAtLeast(version: string | null, min: string): boolean {
  const a = parseSemver(version);
  const b = parseSemver(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return true;
}

export function inspectModApi(cmd: Partial<ModApi> | null | undefined): CompatibilityReport {
  const present: string[] = [];
  const missing: string[] = [];
  const notes: string[] = [];

  if (!cmd || typeof cmd !== "object") {
    return {
      status: "UNSUPPORTED",
      commandCodeVersion: null,
      modApiVersion: MOD_API_VERSION,
      missing: [...REQUIRED_METHODS],
      present: [],
      notes: ["ModApi object missing"],
    };
  }

  for (const key of REQUIRED_METHODS) {
    const value = (cmd as Record<string, unknown>)[key];
    if (typeof value === "function" || (key === "ui" && value && typeof value === "object")) {
      present.push(key);
    } else {
      missing.push(key);
    }
  }

  for (const key of OPTIONAL_METHODS) {
    const value = (cmd as Record<string, unknown>)[key];
    if (typeof value === "function") present.push(key);
  }

  // transformInput is registered via hooks(); we verify hooks is callable.
  if (typeof cmd.hooks === "function") present.push("hooks.transformInput");
  else missing.push("hooks.transformInput");

  if (missing.length > 0) {
    return {
      status: "MISSING_CALLBACK",
      commandCodeVersion: null,
      modApiVersion: MOD_API_VERSION,
      missing,
      present,
      notes: ["Required ModApi callbacks missing; automatic routing disabled"],
    };
  }

  return {
    status: "SUPPORTED",
    commandCodeVersion: null,
    modApiVersion: MOD_API_VERSION,
    missing: [],
    present,
    notes: [`Compatible with CommandCode ≥ ${COMPAT_MIN_COMMANDCODE}`],
  };
}

export function qualifyCommandCodeVersion(
  version: string | null,
  report: CompatibilityReport,
): CompatibilityReport {
  if (!version) {
    return {
      ...report,
      status: report.status === "SUPPORTED" ? "DEGRADED" : report.status,
      notes: [
        ...report.notes,
        "CommandCode version unknown; proceeding with capability checks only",
      ],
    };
  }
  if (!isVersionAtLeast(version, COMPAT_MIN_COMMANDCODE)) {
    return {
      ...report,
      status: "UNSUPPORTED",
      commandCodeVersion: version,
      notes: [...report.notes, `CommandCode ${version} below minimum ${COMPAT_MIN_COMMANDCODE}`],
    };
  }
  return {
    ...report,
    commandCodeVersion: version,
    status: report.status === "MISSING_CALLBACK" ? report.status : "SUPPORTED",
  };
}

export function canRouteAutomatically(report: CompatibilityReport): boolean {
  return report.status === "SUPPORTED" || report.status === "DEGRADED";
}
