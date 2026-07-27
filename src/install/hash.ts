import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export function sha256Buffer(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256File(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256Buffer(readFileSync(path));
}

/** Stable hash of JSON by re-serializing parsed content (key order preserved as stored). */
export function sha256Text(text: string): string {
  return sha256Buffer(text);
}

export function emptyHash(): string {
  return sha256Buffer("");
}
