import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { refreshStatePath } from "./paths.js";
import { type RefreshState, RefreshStateSchema, emptyRefreshState } from "./types.js";

function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, body, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function loadRefreshState(stateRoot?: string): RefreshState {
  const path = refreshStatePath(stateRoot);
  if (!existsSync(path)) return emptyRefreshState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = RefreshStateSchema.safeParse(raw);
    if (!parsed.success) return emptyRefreshState();
    return parsed.data;
  } catch {
    return emptyRefreshState();
  }
}

export function saveRefreshState(state: RefreshState, stateRoot?: string): void {
  const path = refreshStatePath(stateRoot);
  const canonical = RefreshStateSchema.parse(state);
  writeAtomic(path, `${JSON.stringify(canonical, null, 2)}\n`);
}

export function newOwnerInstance(): string {
  return `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
}
