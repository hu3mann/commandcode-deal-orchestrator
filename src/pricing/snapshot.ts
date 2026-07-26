import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { seedDealsPath, seedModelsPath } from "../config/defaults.js";
import { stateDir } from "../config/loader.js";
import { type DealRecord, type DealSnapshot, DealSnapshotSchema } from "../domain/deal.js";
import { type ModelPricing, type PricingSnapshot, PricingSnapshotSchema } from "../domain/model.js";

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

/**
 * The sourceHash content basis: the `models`/`deals` array only (not the wrapping
 * envelope). This must stay stable — refresh.ts, merge-official.ts and the load-time
 * verification below all must hash the exact same thing or every write is a false
 * "tampered" positive.
 */
export function computePricingSourceHash(models: ModelPricing[]): string {
  return sha256(JSON.stringify(models));
}

export function computeDealSourceHash(deals: DealRecord[]): string {
  return sha256(JSON.stringify(deals));
}

/** Write `content` to `path`, fsync the file descriptor, then close it (defect §15 step 8). */
function writeFileFsynced(path: string, content: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, content, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function loadSeedPricingSnapshot(): PricingSnapshot {
  const raw = readFileSync(seedModelsPath(), "utf8");
  const parsed = PricingSnapshotSchema.parse(JSON.parse(raw));
  const expected = computePricingSourceHash(parsed.models);
  if (parsed.sourceHash !== expected) {
    throw new Error(
      `Seed pricing snapshot (${seedModelsPath()}) sourceHash mismatch: expected ${expected}, got "${parsed.sourceHash}". The seed file is the root of trust for offline/seed mode; regenerate its sourceHash (computePricingSourceHash(models)) whenever config/models.seed.json's models change.`,
    );
  }
  return parsed;
}

export function loadSeedDealSnapshot(): DealSnapshot {
  const raw = readFileSync(seedDealsPath(), "utf8");
  const parsed = DealSnapshotSchema.parse(JSON.parse(raw));
  const expected = computeDealSourceHash(parsed.deals);
  if (parsed.sourceHash !== expected) {
    throw new Error(
      `Seed deal snapshot (${seedDealsPath()}) sourceHash mismatch: expected ${expected}, got "${parsed.sourceHash}". Regenerate its sourceHash (computeDealSourceHash(deals)) whenever config/deals.seed.json's deals change.`,
    );
  }
  return parsed;
}

export interface SnapshotLoadResult<T> {
  snapshot: T;
  /** False only when a persisted state-file's sourceHash did not match its own content —
   * i.e. the file was hand-edited/tampered after being written by this codebase. Falling
   * back to the seed (`verified: true` in that case) is the fail-closed behavior; a plain
   * "file missing" or "file corrupt/unparsable" fallback to seed is NOT a tamper signal
   * and is reported as verified. */
  verified: boolean;
  reason?: string;
}

/**
 * Load the persisted pricing snapshot with sourceHash verification (defect: sourceHash was
 * write-only and never checked on load). Recomputes the hash over `models` the same way
 * savePricingSnapshot() computes it at write time; a mismatch means the file was modified
 * out-of-band after being written (hand-edited but schema-valid tampering) and is a fail
 * -closed condition: the tampered file is discarded and the trusted seed is used instead.
 */
export function loadPricingSnapshotChecked(): SnapshotLoadResult<PricingSnapshot> {
  const path = pricingSnapshotPath();
  if (existsSync(path)) {
    try {
      const parsed = PricingSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        const expected = computePricingSourceHash(parsed.data.models);
        if (parsed.data.sourceHash === expected) {
          return { snapshot: parsed.data, verified: true };
        }
        return {
          snapshot: loadSeedPricingSnapshot(),
          verified: false,
          reason: `pricing snapshot at ${path} failed sourceHash verification (expected ${expected}, got "${parsed.data.sourceHash}"); treating as tampered/corrupted and falling back to seed`,
        };
      }
    } catch {
      /* fall through to seed: not a tamper signal, just missing/corrupt/unparsable */
    }
  }
  return { snapshot: loadSeedPricingSnapshot(), verified: true };
}

export function loadDealSnapshotChecked(): SnapshotLoadResult<DealSnapshot> {
  const path = dealsSnapshotPath();
  if (existsSync(path)) {
    try {
      const parsed = DealSnapshotSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        const expected = computeDealSourceHash(parsed.data.deals);
        if (parsed.data.sourceHash === expected) {
          return { snapshot: parsed.data, verified: true };
        }
        return {
          snapshot: loadSeedDealSnapshot(),
          verified: false,
          reason: `deal snapshot at ${path} failed sourceHash verification (expected ${expected}, got "${parsed.data.sourceHash}"); treating as tampered/corrupted and falling back to seed`,
        };
      }
    } catch {
      /* fall through to seed */
    }
  }
  return { snapshot: loadSeedDealSnapshot(), verified: true };
}

export function loadPricingSnapshot(): PricingSnapshot {
  const result = loadPricingSnapshotChecked();
  if (!result.verified && result.reason) {
    console.error(`[ccroute] ${result.reason}`);
  }
  return result.snapshot;
}

export function loadDealSnapshot(): DealSnapshot {
  const result = loadDealSnapshotChecked();
  if (!result.verified && result.reason) {
    console.error(`[ccroute] ${result.reason}`);
  }
  return result.snapshot;
}

/**
 * Atomic write with a correct-by-construction sourceHash: the hash is always recomputed
 * from `models` here, never trusted from the caller. This closes the "write-only
 * sourceHash" gap at the source — a caller that forgets to compute a real hash (or
 * supplies a placeholder) can no longer persist an inconsistent file.
 */
export function savePricingSnapshot(snapshot: PricingSnapshot): void {
  // Canonicalize FIRST, then hash the canonical (post-parse) shape, then persist that
  // exact object. Hashing pre-parse input and writing post-parse output is a trap: zod
  // reconstructs objects in schema-declared key order, which can differ from whatever
  // order the caller's plain object literal used, silently producing a hash that
  // doesn't match the bytes actually written to disk.
  const canonical = PricingSnapshotSchema.parse(snapshot);
  const withHash: PricingSnapshot = {
    ...canonical,
    sourceHash: computePricingSourceHash(canonical.models),
  };
  const path = pricingSnapshotPath();
  ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileFsynced(tmp, `${JSON.stringify(withHash, null, 2)}\n`);
  renameSync(tmp, path);
}

export function saveDealSnapshot(snapshot: DealSnapshot): void {
  const canonical = DealSnapshotSchema.parse(snapshot);
  const withHash: DealSnapshot = {
    ...canonical,
    sourceHash: computeDealSourceHash(canonical.deals),
  };
  const path = dealsSnapshotPath();
  ensureDir(path);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileFsynced(tmp, `${JSON.stringify(withHash, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Thrown when a two-file commit partially succeeds: the pricing file was already
 * replaced but the deals file commit failed. Distinct from a clean pre-commit failure so
 * callers can report `preservedPrior: false` instead of falsely claiming prior state was
 * preserved. */
export class PartialCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartialCommitError";
  }
}

/**
 * Commit pricing + deals snapshots together. Both are validated and fully staged
 * (written + fsynced to temp files) BEFORE either live file is touched, so a validation
 * or disk-write failure never touches the live files at all (prior state genuinely
 * preserved). The two renames themselves are each atomic on POSIX, but are not a single
 * cross-file transaction; if the second rename fails after the first succeeds, that is
 * surfaced as PartialCommitError instead of being swallowed and reported as
 * "prior preserved" (defect: a failure between the two saves used to report
 * `preservedPrior: true` even though pricing had already been replaced).
 */
export function commitPricingAndDeals(pricing: PricingSnapshot, deals: DealSnapshot): void {
  // Canonicalize first, then hash the canonical shape (see savePricingSnapshot for why
  // order matters here).
  const pricingCanonical = PricingSnapshotSchema.parse(pricing);
  const dealsCanonical = DealSnapshotSchema.parse(deals);
  const pricingValidated: PricingSnapshot = {
    ...pricingCanonical,
    sourceHash: computePricingSourceHash(pricingCanonical.models),
  };
  const dealsValidated: DealSnapshot = {
    ...dealsCanonical,
    sourceHash: computeDealSourceHash(dealsCanonical.deals),
  };

  const pricingPath = pricingSnapshotPath();
  const dealsPath = dealsSnapshotPath();
  ensureDir(pricingPath);
  ensureDir(dealsPath);

  const pricingTmp = `${pricingPath}.tmp.${process.pid}`;
  const dealsTmp = `${dealsPath}.tmp.${process.pid}`;

  // Stage both files fully (written + fsynced) before any live file is mutated.
  writeFileFsynced(pricingTmp, `${JSON.stringify(pricingValidated, null, 2)}\n`);
  writeFileFsynced(dealsTmp, `${JSON.stringify(dealsValidated, null, 2)}\n`);

  renameSync(pricingTmp, pricingPath);
  try {
    renameSync(dealsTmp, dealsPath);
  } catch (e) {
    throw new PartialCommitError(
      `Partial commit: pricing snapshot was updated but the deals snapshot commit failed (${(e as Error).message}). State is inconsistent between pricing and deals; re-run refresh.`,
    );
  }
}

export function snapshotAgeMs(retrievedAt: string, now = Date.now()): number {
  const t = Date.parse(retrievedAt);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now - t);
}

/** §15 staleness policy thresholds. Configurable; router callers should thread the
 * routing config's own thresholds through here once wired up (see report). */
export interface FreshnessThresholds {
  freshMaxAgeMs: number;
  acceptableMaxAgeMs: number;
}

export const DEFAULT_FRESHNESS_THRESHOLDS: FreshnessThresholds = {
  freshMaxAgeMs: 24 * 60 * 60 * 1000,
  acceptableMaxAgeMs: 72 * 60 * 60 * 1000,
};

export type SnapshotFreshness = "fresh" | "acceptable" | "stale";

export function classifySnapshotFreshness(
  ageMs: number,
  thresholds: FreshnessThresholds = DEFAULT_FRESHNESS_THRESHOLDS,
): SnapshotFreshness {
  if (ageMs < thresholds.freshMaxAgeMs) return "fresh";
  if (ageMs < thresholds.acceptableMaxAgeMs) return "acceptable";
  return "stale";
}

export interface PricingUsabilityInput {
  model: ModelPricing;
  /** The pricing snapshot's retrievedAt (or the deals snapshot's, whichever is older, if
   * both are relevant to the caller). */
  retrievedAt: string;
  now?: Date;
  thresholds?: FreshnessThresholds;
}

export interface PricingUsabilityResult {
  usable: boolean;
  freshness: SnapshotFreshness;
  ageMs: number;
  /** True when this model carries a deal or a temporary/introductory rate whose
   * correctness depends on the snapshot being current. */
  dealAffectsModel: boolean;
  reason: string;
}

/**
 * §15 staleness gate: fresh (<24h) and acceptable (24-72h) snapshots are always usable.
 * A stale (>72h) snapshot is usable ONLY when no deal or temporary rate affects the
 * model — a free/expiring deal (or a temporary_introductory_rate) cannot be trusted from
 * data old enough that it may have silently expired since it was retrieved.
 *
 * This is exported for router/eligibility (owned elsewhere) to call per-candidate model;
 * see the integration note in the final report for the exact call site.
 */
export function evaluatePricingUsability(input: PricingUsabilityInput): PricingUsabilityResult {
  const now = input.now ?? new Date();
  const ageMs = snapshotAgeMs(input.retrievedAt, now.getTime());
  const thresholds = input.thresholds ?? DEFAULT_FRESHNESS_THRESHOLDS;
  const freshness = classifySnapshotFreshness(ageMs, thresholds);
  const model = input.model;
  const dealAffectsModel =
    Boolean(model.deal) || model.priceBasis === "temporary_introductory_rate";
  const ageSeconds = Math.round(ageMs / 1000);

  if (freshness !== "stale") {
    return {
      usable: true,
      freshness,
      ageMs,
      dealAffectsModel,
      reason: `${freshness} snapshot (age=${ageSeconds}s)`,
    };
  }
  if (dealAffectsModel) {
    return {
      usable: false,
      freshness,
      ageMs,
      dealAffectsModel,
      reason:
        `stale snapshot (age=${ageSeconds}s, older than acceptableMaxAgeMs=${thresholds.acceptableMaxAgeMs}) ` +
        `affects a model with an active deal/temporary rate for ${model.id}; refusing to trust it`,
    };
  }
  return {
    usable: true,
    freshness,
    ageMs,
    dealAffectsModel,
    reason: `stale snapshot (age=${ageSeconds}s) but ${model.id} has no deal/temporary rate affecting it; usable`,
  };
}
