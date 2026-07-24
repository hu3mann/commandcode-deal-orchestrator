import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seedDealsPath, seedModelsPath } from "../config/defaults.js";
import { stateDir } from "../config/loader.js";
import { type DealSnapshot, DealSnapshotSchema } from "../domain/deal.js";
import { type PricingSnapshot, PricingSnapshotSchema } from "../domain/model.js";

export function pricingSnapshotPath(): string {
  return join(stateDir(), "pricing-snapshot.json");
}

export function dealsSnapshotPath(): string {
  return join(stateDir(), "deals-snapshot.json");
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function loadSeedPricingSnapshot(): PricingSnapshot {
  const raw = readFileSync(seedModelsPath(), "utf8");
  return PricingSnapshotSchema.parse(JSON.parse(raw));
}

export function loadSeedDealSnapshot(): DealSnapshot {
  const raw = readFileSync(seedDealsPath(), "utf8");
  return DealSnapshotSchema.parse(JSON.parse(raw));
}

export function loadPricingSnapshot(): PricingSnapshot {
  const path = pricingSnapshotPath();
  if (existsSync(path)) {
    try {
      const parsed = PricingSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through to seed */
    }
  }
  return loadSeedPricingSnapshot();
}

export function loadDealSnapshot(): DealSnapshot {
  const path = dealsSnapshotPath();
  if (existsSync(path)) {
    try {
      const parsed = DealSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) return parsed.data;
    } catch {
      /* fall through */
    }
  }
  return loadSeedDealSnapshot();
}

/** Atomic write: never replace good data with partial/invalid data */
export function savePricingSnapshot(snapshot: PricingSnapshot): void {
  const validated = PricingSnapshotSchema.parse(snapshot);
  const path = pricingSnapshotPath();
  ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function saveDealSnapshot(snapshot: DealSnapshot): void {
  const validated = DealSnapshotSchema.parse(snapshot);
  const path = dealsSnapshotPath();
  ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function snapshotAgeMs(retrievedAt: string, now = Date.now()): number {
  const t = Date.parse(retrievedAt);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - t);
}
