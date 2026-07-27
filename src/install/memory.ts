/**
 * Optional project memory: managed block in AGENTS.md (never default-on).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File, sha256Text } from "./hash.js";
import type { InstallPaths } from "./paths.js";
import { INSTALL_OWNERSHIP_MARKER, type ManagedFileEntry } from "./types.js";

export const MEMORY_BEGIN = "BEGIN CCROUTE MANAGED POLICY";
export const MEMORY_END = "END CCROUTE MANAGED POLICY";

export const DEFAULT_MEMORY_BODY = [
  "Use ccroute for explicit cost-aware routing workflows.",
  "Do not invent model IDs.",
  "Do not invoke ccroute from CCROUTE_CHILD sessions.",
  "Repository writes remain subject to user authorization.",
].join("\n");

export function agentsMdPath(paths: InstallPaths): string {
  return join(paths.projectRoot, "AGENTS.md");
}

export function wrapManagedMemory(body = DEFAULT_MEMORY_BODY): string {
  return [`<!-- ${MEMORY_BEGIN} -->`, body.trim(), `<!-- ${MEMORY_END} -->`, ""].join("\n");
}

export function extractManagedMemory(text: string): {
  hasBlock: boolean;
  before: string;
  body: string;
  after: string;
} {
  const begin = `<!-- ${MEMORY_BEGIN} -->`;
  const end = `<!-- ${MEMORY_END} -->`;
  const i = text.indexOf(begin);
  const j = text.indexOf(end);
  if (i < 0 || j < 0 || j < i) {
    return { hasBlock: false, before: text, body: "", after: "" };
  }
  const before = text.slice(0, i);
  const body = text.slice(i + begin.length, j).replace(/^\n+|\n+$/g, "");
  const after = text.slice(j + end.length).replace(/^\n/, "");
  return { hasBlock: true, before, body, after };
}

export function installMemoryBlock(
  paths: InstallPaths,
  body = DEFAULT_MEMORY_BODY,
): ManagedFileEntry {
  const path = agentsMdPath(paths);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const extracted = extractManagedMemory(existing);
  const block = wrapManagedMemory(body);
  let next: string;
  if (extracted.hasBlock) {
    next = `${extracted.before}${block}${extracted.after}`;
  } else if (existing.trim()) {
    next = `${existing.replace(/\s*$/, "\n\n")}${block}`;
  } else {
    next = block;
  }
  writeFileSync(path, next.endsWith("\n") ? next : `${next}\n`, "utf8");
  return {
    path,
    sha256: sha256File(path) ?? sha256Text(next),
    method: "copy",
    sourceArtifact: "memory:AGENTS.md",
    ownershipMarker: INSTALL_OWNERSHIP_MARKER,
  };
}

export function removeMemoryBlock(paths: InstallPaths): {
  removed: boolean;
  path: string;
  messages: string[];
} {
  const path = agentsMdPath(paths);
  const messages: string[] = [];
  if (!existsSync(path)) {
    return { removed: false, path, messages: ["AGENTS.md absent — nothing to remove"] };
  }
  const existing = readFileSync(path, "utf8");
  const extracted = extractManagedMemory(existing);
  if (!extracted.hasBlock) {
    return {
      removed: false,
      path,
      messages: ["No managed CCROUTE memory block present — left AGENTS.md untouched"],
    };
  }
  const next = `${extracted.before}${extracted.after}`.replace(/\n{3,}/g, "\n\n");
  // If only whitespace remains, leave a minimal empty file rather than delete user file
  writeFileSync(path, next.trim() ? (next.endsWith("\n") ? next : `${next}\n`) : "", "utf8");
  messages.push("Removed only the managed CCROUTE memory block from AGENTS.md");
  return { removed: true, path, messages };
}

export function memoryBlockPresent(paths: InstallPaths): boolean {
  const path = agentsMdPath(paths);
  if (!existsSync(path)) return false;
  return extractManagedMemory(readFileSync(path, "utf8")).hasBlock;
}
