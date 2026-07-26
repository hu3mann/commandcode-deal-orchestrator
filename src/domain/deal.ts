import { z } from "zod";
import { type Deal, type DealKind, DealSchema } from "./model.js";

export const DealRecordSchema = DealSchema.extend({
  modelId: z.string().min(1),
});
export type DealRecord = z.infer<typeof DealRecordSchema>;

export const DealSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  retrievedAt: z.string(),
  source: z.string(),
  sourceHash: z.string(),
  deals: z.array(DealRecordSchema),
});
export type DealSnapshot = z.infer<typeof DealSnapshotSchema>;

/**
 * §14 deal-kind taxonomy resolver. `deal.kind` is the authoritative field when present;
 * for back-compat with data authored against the legacy 3-value `type` field (seed files,
 * hand-authored config, older snapshots), derive the equivalent §14 kind from `type`.
 * This mapping is total: every legacy `type` value maps to exactly one §14 kind, and
 * `multiplier`/`fixed_rate` are only ever reached via an explicit `kind`.
 */
export function resolveDealKind(deal: Deal): DealKind {
  if (deal.kind) return deal.kind;
  switch (deal.type) {
    case "free":
      return "free";
    case "permanent_price_reduction":
      return "permanent_rate";
    case "temporary_rate":
      return "temporary_rate";
    default:
      // Unreachable for schema-valid data (DealSchema.type is an exhaustive z.enum).
      return "permanent_rate";
  }
}

/**
 * Inclusive expiry boundary (§15): a deal remains valid through and including the exact
 * expiry instant and becomes expired only strictly *after* that instant. Two ISO strings
 * naming the same instant (regardless of UTC-offset representation) compare equal because
 * comparison happens on parsed epoch millis, not string content.
 */
export function isDealExpired(expiresAt: string | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return true;
  return exp.getTime() < now.getTime();
}

/**
 * §14: a deal whose `startsAt` is in the future has not begun yet and must not be applied.
 * `startsAt` becomes active exactly at the named instant (symmetric with the expiry
 * boundary above).
 */
export function isDealPending(startsAt: string | null | undefined, now = new Date()): boolean {
  if (!startsAt) return false;
  const t = Date.parse(startsAt);
  if (Number.isNaN(t)) return false;
  return now.getTime() < t;
}

/** A deal is "active" only within its [startsAt, expiresAt] window (both inclusive). */
export function isDealActive(deal: Deal | undefined, now = new Date()): boolean {
  if (!deal) return false;
  return !isDealExpired(deal.expiresAt, now) && !isDealPending(deal.startsAt, now);
}
