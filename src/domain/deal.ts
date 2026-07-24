import { z } from "zod";
import { DealSchema } from "./model.js";

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

export function isDealExpired(expiresAt: string | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return true;
  return exp.getTime() <= now.getTime();
}
