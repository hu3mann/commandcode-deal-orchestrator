/**
 * Managed CommandCode agent definitions (bounded, read-only).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { packageRoot } from "../config/defaults.js";
import { sha256File } from "../install/hash.js";
import type { InstallPaths } from "../install/paths.js";
import type { ManagedFileEntry } from "../install/types.js";
import { INSTALL_OWNERSHIP_MARKER } from "../install/types.js";
import {
  AGENT_OWNERSHIP_MARKER,
  type AgentFrontmatter,
  AgentFrontmatterSchema,
  type AgentsRefreshState,
  AgentsRefreshStateSchema,
  MANAGED_AGENT_NAMES,
  type ManagedAgentName,
} from "./types.js";

export function agentsSourceDir(pkgRoot = packageRoot()): string {
  return join(pkgRoot, "agents");
}

export function agentsDestDir(paths: InstallPaths): string {
  return join(paths.commandcodeDir, "agents");
}

export function agentDestPath(paths: InstallPaths, name: string): string {
  return join(agentsDestDir(paths), name, "AGENT.md");
}

export function agentsRefreshStatePath(paths: InstallPaths): string {
  return join(agentsDestDir(paths), "ccroute-agents-refresh.json");
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

export function parseAgentMarkdown(text: string): {
  frontmatter: AgentFrontmatter;
  body: string;
} {
  const m = text.match(FRONTMATTER_RE);
  if (!m) {
    throw new Error("Agent definition missing YAML frontmatter");
  }
  const raw: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed === "tools:" || trimmed.startsWith("tools:")) {
      raw.tools = [];
      continue;
    }
    if (trimmed.startsWith("- ") && Array.isArray(raw.tools)) {
      (raw.tools as string[]).push(trimmed.slice(2).trim());
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!;
    let val: unknown = kv[2]!.trim();
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (typeof val === "string" && /^-?\d+$/.test(val)) val = Number(val);
    else if (typeof val === "string" && val.startsWith("[") && val.endsWith("]")) {
      val = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    raw[key] = val;
  }
  const frontmatter = AgentFrontmatterSchema.parse(raw);
  return { frontmatter, body: m[2] ?? "" };
}

export function serializeAgentMarkdown(frontmatter: AgentFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${frontmatter.name}`);
  lines.push(`description: ${frontmatter.description}`);
  lines.push(`model: ${frontmatter.model}`);
  if (frontmatter.permissionMode) lines.push(`permissionMode: ${frontmatter.permissionMode}`);
  if (frontmatter.tools?.length) {
    lines.push("tools:");
    for (const t of frontmatter.tools) lines.push(`  - ${t}`);
  }
  if (frontmatter.maxTurns !== undefined) lines.push(`maxTurns: ${frontmatter.maxTurns}`);
  if (frontmatter.delegation !== undefined) lines.push(`delegation: ${frontmatter.delegation}`);
  lines.push(`ownershipMarker: ${frontmatter.ownershipMarker ?? AGENT_OWNERSHIP_MARKER}`);
  lines.push("---");
  lines.push("");
  lines.push(body.replace(/^\n+/, "").replace(/\n+$/, ""));
  lines.push("");
  return lines.join("\n");
}

export function listBundledAgents(pkgRoot = packageRoot()): ManagedAgentName[] {
  const root = agentsSourceDir(pkgRoot);
  if (!existsSync(root)) return [...MANAGED_AGENT_NAMES];
  const found = readdirSync(root).filter((n) =>
    (MANAGED_AGENT_NAMES as readonly string[]).includes(n),
  ) as ManagedAgentName[];
  return found.length ? found : [...MANAGED_AGENT_NAMES];
}

export function readBundledAgent(
  name: ManagedAgentName,
  pkgRoot = packageRoot(),
): { frontmatter: AgentFrontmatter; body: string; text: string } {
  const path = join(agentsSourceDir(pkgRoot), name, "AGENT.md");
  const text = readFileSync(path, "utf8");
  const parsed = parseAgentMarkdown(text);
  return { ...parsed, text };
}

export function installAgentsSurface(paths: InstallPaths): ManagedFileEntry[] {
  const entries: ManagedFileEntry[] = [];
  const destRoot = agentsDestDir(paths);
  mkdirSync(destRoot, { recursive: true });

  for (const name of listBundledAgents(paths.packageRoot)) {
    const bundled = readBundledAgent(name, paths.packageRoot);
    // Project agents must stay portable
    const fm: AgentFrontmatter = {
      ...bundled.frontmatter,
      model: paths.scope === "project" ? "inherit" : bundled.frontmatter.model,
      ownershipMarker: AGENT_OWNERSHIP_MARKER,
    };
    const text = serializeAgentMarkdown(fm, bundled.body);
    const dest = agentDestPath(paths, name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text, "utf8");
    entries.push({
      path: dest,
      sha256: sha256File(dest) ?? "",
      method: "copy",
      sourceArtifact: `agent:${name}`,
      ownershipMarker: INSTALL_OWNERSHIP_MARKER,
    });
    const marker = join(dirname(dest), ".ccroute-owned");
    writeFileSync(marker, `${AGENT_OWNERSHIP_MARKER}\n`, "utf8");
    entries.push({
      path: marker,
      sha256: sha256File(marker) ?? "",
      method: "copy",
      sourceArtifact: `agent:${name}:ownership-marker`,
      ownershipMarker: INSTALL_OWNERSHIP_MARKER,
    });
  }
  return entries;
}

export function removeAgentsSurface(paths: InstallPaths, managed: ManagedFileEntry[]): void {
  for (const f of managed) {
    if (f.sourceArtifact.startsWith("agent:") && existsSync(f.path)) {
      try {
        rmSync(f.path, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  // Remove empty agent dirs
  const root = agentsDestDir(paths);
  if (!existsSync(root)) return;
  for (const name of MANAGED_AGENT_NAMES) {
    const dir = join(root, name);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

export function loadAgentsRefreshState(paths: InstallPaths): AgentsRefreshState | null {
  const p = agentsRefreshStatePath(paths);
  if (!existsSync(p)) return null;
  try {
    return AgentsRefreshStateSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

export function saveAgentsRefreshState(paths: InstallPaths, state: AgentsRefreshState): void {
  const p = agentsRefreshStatePath(paths);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export interface AgentsRefreshResult {
  ok: boolean;
  scope: "project" | "user";
  updated: string[];
  selectedIds: Record<string, string>;
  messages: string[];
  error?: string;
}

/**
 * Refresh managed agents against the live catalog.
 * Project scope: force model: inherit (portable).
 * User scope: optional pin only when pinModel is an exact live ID (never invent).
 */
export function refreshManagedAgents(opts: {
  paths: InstallPaths;
  liveIds: string[];
  pinModel?: string | null;
  allowPromotionalPins?: boolean;
}): AgentsRefreshResult {
  const { paths, liveIds, pinModel, allowPromotionalPins } = opts;
  const messages: string[] = [];
  const updated: string[] = [];
  const selectedIds: Record<string, string> = {};
  const liveSet = new Set(liveIds);

  if (pinModel && !liveSet.has(pinModel)) {
    return {
      ok: false,
      scope: paths.scope,
      updated: [],
      selectedIds: {},
      messages: [],
      error: `Refusing unavailable route: model "${pinModel}" is not in the live catalog`,
    };
  }

  if (pinModel && !allowPromotionalPins && /free|promo|trial/i.test(pinModel)) {
    return {
      ok: false,
      scope: paths.scope,
      updated: [],
      selectedIds: {},
      messages: [],
      error: `Refusing promotional model pin "${pinModel}" unless --allow-promotional-pins is set`,
    };
  }

  // Ensure agents exist
  if (!existsSync(agentDestPath(paths, "ccroute-planner"))) {
    installAgentsSurface(paths);
    messages.push("Installed missing managed agents before refresh");
  }

  for (const name of MANAGED_AGENT_NAMES) {
    const dest = agentDestPath(paths, name);
    if (!existsSync(dest)) continue;
    const text = readFileSync(dest, "utf8");
    let parsed: { frontmatter: AgentFrontmatter; body: string };
    try {
      parsed = parseAgentMarkdown(text);
    } catch (e) {
      messages.push(`Skip ${name}: ${(e as Error).message}`);
      continue;
    }

    let model = "inherit";
    if (paths.scope === "user" && pinModel) {
      model = pinModel;
    } else if (paths.scope === "project") {
      model = "inherit";
    } else {
      // user without pin: keep inherit for portability unless already a live pin
      const current = parsed.frontmatter.model;
      model = current !== "inherit" && liveSet.has(current) ? current : "inherit";
    }

    const nextFm: AgentFrontmatter = {
      ...parsed.frontmatter,
      model,
      ownershipMarker: AGENT_OWNERSHIP_MARKER,
    };
    writeFileSync(dest, serializeAgentMarkdown(nextFm, parsed.body), "utf8");
    selectedIds[name] = model;
    updated.push(name);
  }

  const state: AgentsRefreshState = {
    schemaVersion: 1,
    scope: paths.scope,
    updatedAt: new Date().toISOString(),
    liveCatalogInspected: liveIds.length > 0,
    selectedIds,
    notes: messages,
  };
  saveAgentsRefreshState(paths, state);
  messages.push(
    paths.scope === "project"
      ? "Project agents use model: inherit (portable)"
      : pinModel
        ? `User agents pinned to live id ${pinModel}`
        : "User agents left on inherit or prior live pins",
  );

  return {
    ok: true,
    scope: paths.scope,
    updated,
    selectedIds,
    messages,
  };
}
