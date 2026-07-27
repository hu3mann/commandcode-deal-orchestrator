import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type InstallManifest, InstallManifestSchema, type InstallationStatus } from "./types.js";

export function readManifest(path: string): InstallManifest | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(
      `Install manifest is malformed at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const parsed = InstallManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Install manifest failed schema validation at ${path}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function writeManifestAtomic(path: string, manifest: InstallManifest): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${MANIFEST_TMP_PREFIX}${process.pid}.json`);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o644);
  } catch {
    /* best-effort */
  }
}

const MANIFEST_TMP_PREFIX = "ccroute-manifest-";

export function removeManifest(path: string): void {
  if (!existsSync(path)) return;
  unlinkSync(path);
}

export function withStatus(
  manifest: InstallManifest,
  status: InstallationStatus,
  updatedAt = new Date().toISOString(),
): InstallManifest {
  return { ...manifest, installationStatus: status, updatedAt };
}

export function fileMode(path: string): number | null {
  if (!existsSync(path)) return null;
  return statSync(path).mode & 0o777;
}
