import type { ModelTelemetry, TelemetryEvent } from "../domain/telemetry.js";
import { ModelTelemetrySchema } from "../domain/telemetry.js";

export function aggregateByModel(events: TelemetryEvent[]): Map<string, ModelTelemetry> {
  const map = new Map<string, ModelTelemetry>();

  const ensure = (id: string): ModelTelemetry => {
    let m = map.get(id);
    if (!m) {
      m = ModelTelemetrySchema.parse({ modelId: id });
      map.set(id, m);
    }
    return m;
  };

  for (const e of events) {
    if (!e.modelId) continue;
    const m = ensure(e.modelId);
    if (e.event === "run_start" || e.event === "role_start") {
      m.attempts += 1;
    }
    if (e.success === true) m.successfulRuns += 1;
    if (e.success === false) m.failedRuns += 1;
    if (e.event === "timeout") m.timeouts += 1;
    if (e.event === "schema_failure") m.schemaFailures += 1;
    if (e.event === "repair") m.repairTurns += 1;
    if (e.latencyMs !== undefined) {
      const n = m.successfulRuns + m.failedRuns || 1;
      m.averageLatencyMs = (m.averageLatencyMs * (n - 1) + e.latencyMs) / n;
    }
    if (e.estimatedCostUsd !== undefined) m.estimatedCost += e.estimatedCostUsd;
    if (e.observedCostUsd !== undefined) {
      m.observedCost = (m.observedCost ?? 0) + e.observedCostUsd;
    }
    if (e.event === "override") m.operatorOverrides += 1;
  }
  return map;
}

export function formatStats(
  byModel: Map<string, ModelTelemetry>,
  filter?: { modelId?: string; taskClass?: string },
  events: TelemetryEvent[] = [],
): string {
  const lines: string[] = ["## ccroute stats", ""];
  let models = [...byModel.values()];
  if (filter?.modelId) models = models.filter((m) => m.modelId === filter.modelId);
  if (filter?.taskClass) {
    const ids = new Set(
      events.filter((e) => e.taskClass === filter.taskClass && e.modelId).map((e) => e.modelId!),
    );
    models = models.filter((m) => ids.has(m.modelId));
  }
  if (models.length === 0) {
    lines.push("No telemetry yet.");
    return lines.join("\n");
  }
  for (const m of models.sort((a, b) => a.modelId.localeCompare(b.modelId))) {
    const rate = m.attempts ? ((m.successfulRuns / m.attempts) * 100).toFixed(1) : "n/a";
    lines.push(
      `${m.modelId}: attempts=${m.attempts} success=${m.successfulRuns} fail=${m.failedRuns} rate=${rate}% avgLat=${Math.round(m.averageLatencyMs)}ms estCost=$${m.estimatedCost.toFixed(4)}`,
    );
  }
  return lines.join("\n");
}
