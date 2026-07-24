import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";

export function assertPathInsideRoot(target: string, root: string): string {
  const absRoot = resolve(root);
  const absTarget = resolve(isAbsolute(target) ? target : joinSafe(root, target));
  let realRoot = absRoot;
  let realTarget = absTarget;
  try {
    realRoot = realpathSync(absRoot);
  } catch {
    /* root may not exist yet */
  }
  try {
    realTarget = realpathSync(absTarget);
  } catch {
    // target may not exist; use normalized path
    realTarget = normalize(absTarget);
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (realTarget !== realRoot && !realTarget.startsWith(prefix)) {
    throw new Error(`Path escapes root: ${target}`);
  }
  return realTarget;
}

function joinSafe(root: string, rel: string): string {
  return resolve(root, rel);
}
