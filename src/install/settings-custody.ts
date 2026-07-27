/**
 * Atomic settings custody for optional hook fallback merges.
 *
 * Hard rules:
 * - Parse safely; never overwrite malformed settings
 * - Preserve unknown keys, permissions, taste, profile, unrelated hooks
 * - Merge by stable identity (event + matcher + normalized command + ownership marker)
 * - Atomic write + timestamped backup + before/after hashes
 * - Never restore a full settings backup over later user changes
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { emptyHash, sha256Text } from "./hash.js";
import { HOOK_OWNERSHIP_MARKER } from "./types.js";

export interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
  type?: string;
}

export interface SettingsLoadResult {
  path: string;
  exists: boolean;
  text: string;
  hash: string;
  data: Record<string, unknown> | null;
  parseError?: string;
  mode: number | null;
}

export function loadSettings(path: string): SettingsLoadResult {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      text: "",
      hash: emptyHash(),
      data: {},
      mode: null,
    };
  }
  const mode = statSync(path).mode & 0o777;
  const text = readFileSync(path, "utf8");
  const hash = sha256Text(text);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        path,
        exists: true,
        text,
        hash,
        data: null,
        parseError: "settings root must be a JSON object",
        mode,
      };
    }
    return { path, exists: true, text, hash, data: parsed as Record<string, unknown>, mode };
  } catch (e) {
    return {
      path,
      exists: true,
      text,
      hash,
      data: null,
      parseError: e instanceof Error ? e.message : String(e),
      mode,
    };
  }
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

export function hookIdentity(spec: {
  event: string;
  matcher?: string;
  command: string;
  ownershipMarker?: string;
}): string {
  const marker = spec.ownershipMarker ?? HOOK_OWNERSHIP_MARKER;
  return [spec.event, spec.matcher ?? "", normalizeCommand(spec.command), marker].join("\0");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Extract managed hook command entries (by ownership marker in command or marker field).
 */
export function listManagedHookIdentities(
  data: Record<string, unknown>,
  marker = HOOK_OWNERSHIP_MARKER,
): string[] {
  const hooks = data.hooks;
  if (!isRecord(hooks)) return [];
  const out: string[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const inner = group.hooks;
      if (!Array.isArray(inner)) continue;
      for (const h of inner) {
        if (!isRecord(h)) continue;
        const command = typeof h.command === "string" ? h.command : "";
        const owned =
          h.ownershipMarker === marker ||
          (typeof h.ccroute === "string" && h.ccroute === marker) ||
          command.includes(marker);
        if (owned) {
          out.push(hookIdentity({ event, matcher, command, ownershipMarker: marker }));
        }
      }
    }
  }
  return out;
}

/**
 * Merge hook specs into settings without clobbering unrelated entries.
 * Dedupes by stable identity. Returns a new object (does not mutate input).
 */
export function mergeHooks(
  data: Record<string, unknown>,
  specs: HookSpec[],
  marker = HOOK_OWNERSHIP_MARKER,
): { data: Record<string, unknown>; identities: string[] } {
  const next: Record<string, unknown> = { ...data };
  const hooksRoot: Record<string, unknown> = isRecord(data.hooks)
    ? { ...(data.hooks as Record<string, unknown>) }
    : {};

  const identities: string[] = [];

  for (const spec of specs) {
    const id = hookIdentity({ ...spec, ownershipMarker: marker });
    identities.push(id);

    const existingGroups = Array.isArray(hooksRoot[spec.event])
      ? [...(hooksRoot[spec.event] as unknown[])]
      : [];

    // Remove prior managed entries with same identity
    const cleanedGroups: unknown[] = [];
    for (const group of existingGroups) {
      if (!isRecord(group)) {
        cleanedGroups.push(group);
        continue;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const inner = Array.isArray(group.hooks) ? [...(group.hooks as unknown[])] : [];
      const kept = inner.filter((h) => {
        if (!isRecord(h)) return true;
        const command = typeof h.command === "string" ? h.command : "";
        const hId = hookIdentity({
          event: spec.event,
          matcher,
          command,
          ownershipMarker: marker,
        });
        const owned =
          h.ownershipMarker === marker || h.ccroute === marker || command.includes(marker);
        // Drop exact identity match or any managed entry we're replacing for same event+matcher+command
        if (owned && hId === id) return false;
        return true;
      });
      if (kept.length === 0 && inner.length > 0) {
        // group emptied of only managed hooks — drop empty group if no other fields matter
        if (Object.keys(group).every((k) => k === "hooks" || k === "matcher")) {
          continue;
        }
      }
      cleanedGroups.push({ ...group, hooks: kept });
    }

    // Find group with matching matcher (or no matcher)
    const targetIdx = cleanedGroups.findIndex((g) => {
      if (!isRecord(g)) return false;
      const m = typeof g.matcher === "string" ? g.matcher : undefined;
      return m === spec.matcher;
    });

    const hookEntry: Record<string, unknown> = {
      type: spec.type ?? "command",
      command: spec.command,
      timeout: spec.timeout ?? 2,
      ownershipMarker: marker,
      ccroute: marker,
    };

    if (targetIdx < 0) {
      const group: Record<string, unknown> = { hooks: [hookEntry] };
      if (spec.matcher !== undefined) group.matcher = spec.matcher;
      cleanedGroups.push(group);
    } else {
      const g = cleanedGroups[targetIdx] as Record<string, unknown>;
      const inner = Array.isArray(g.hooks) ? [...(g.hooks as unknown[])] : [];
      // prevent duplicate command even without marker
      const already = inner.some(
        (h) =>
          isRecord(h) &&
          typeof h.command === "string" &&
          normalizeCommand(h.command) === normalizeCommand(spec.command),
      );
      if (!already) inner.push(hookEntry);
      cleanedGroups[targetIdx] = { ...g, hooks: inner };
    }

    hooksRoot[spec.event] = cleanedGroups;
  }

  next.hooks = hooksRoot;
  return { data: next, identities };
}

/**
 * Remove only ccroute-owned hook entries by identity set.
 */
export function unmergeHooks(
  data: Record<string, unknown>,
  identities: string[],
  marker = HOOK_OWNERSHIP_MARKER,
): Record<string, unknown> {
  const idSet = new Set(identities);
  if (!isRecord(data.hooks)) return { ...data };
  const hooksRoot: Record<string, unknown> = { ...(data.hooks as Record<string, unknown>) };

  for (const [event, groups] of Object.entries(hooksRoot)) {
    if (!Array.isArray(groups)) continue;
    const nextGroups: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group)) {
        nextGroups.push(group);
        continue;
      }
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const inner = Array.isArray(group.hooks) ? (group.hooks as unknown[]) : [];
      const kept = inner.filter((h) => {
        if (!isRecord(h)) return true;
        const command = typeof h.command === "string" ? h.command : "";
        const owned =
          h.ownershipMarker === marker || h.ccroute === marker || command.includes(marker);
        if (!owned) return true;
        const id = hookIdentity({ event, matcher, command, ownershipMarker: marker });
        return !idSet.has(id);
      });
      if (kept.length === 0 && inner.length > 0) {
        // drop empty managed-only group
        continue;
      }
      nextGroups.push({ ...group, hooks: kept });
    }
    if (nextGroups.length === 0) {
      delete hooksRoot[event];
    } else {
      hooksRoot[event] = nextGroups;
    }
  }

  const next = { ...data, hooks: hooksRoot };
  if (Object.keys(hooksRoot).length === 0) {
    // preserve empty hooks object only if it existed; otherwise drop if we created it
    // Keep key if other code expects it — safer to leave empty object than delete user key
  }
  return next;
}

export function writeSettingsAtomic(
  path: string,
  data: Record<string, unknown>,
  opts?: { previousMode?: number | null },
): { text: string; hash: string } {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const hash = sha256Text(text);
  const tmp = join(dir, `.ccroute-settings-${process.pid}.tmp`);
  const mode = opts?.previousMode ?? 0o644;
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  /* v8 ignore next */
  /* v8 ignore next */
  } catch {
    /* best-effort */
  }
  return { text, hash };
}

export function backupSettings(
  settingsPath: string,
  backupDir: string,
  now = new Date(),
): string | null {
  if (!existsSync(settingsPath)) return null;
  mkdirSync(backupDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const dest = join(backupDir, `settings-${stamp}.json`);
  copyFileSync(settingsPath, dest);
  try {
    const mode = statSync(settingsPath).mode & 0o777;
    chmodSync(dest, mode);
  /* v8 ignore next */
  /* v8 ignore next */
  } catch {
    /* best-effort */
  }
  return dest;
}

export function settingsBasename(path: string): string {
  return basename(path);
}
