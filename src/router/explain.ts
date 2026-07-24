import type { RouteDecision } from "../domain/route.js";
import type { ClassifiedTask } from "../domain/task.js";

export function formatExplain(task: ClassifiedTask, decision: RouteDecision): string {
  const lines: string[] = [];
  lines.push("## ccroute explain");
  lines.push("");
  lines.push(`Task class: ${decision.taskClass}`);
  lines.push(`Risk level: ${task.riskLevel}`);
  lines.push(`Profile: ${decision.profile}`);
  lines.push(`Quality floor: ${decision.qualityFloor}`);
  lines.push(`Signals: ${task.signals.join(", ") || "(none)"}`);
  lines.push(`Required capabilities: ${task.requiredCapabilities.join(", ") || "(none)"}`);
  lines.push(`Overrides: ${decision.overridesApplied.join(", ") || "(none)"}`);
  lines.push("");
  lines.push("### Selected");
  lines.push(`Model: ${decision.selectedModelId}`);
  const sel = decision.candidates.find((c) => c.modelId === decision.selectedModelId);
  if (sel) {
    lines.push(`Expected total cost (estimate): $${sel.cost.expectedTotalCost.toFixed(6)}`);
    lines.push(
      `  fresh input: ${sel.cost.freshInputTokens} tok → $${sel.cost.freshInputCost.toFixed(6)}`,
    );
    lines.push(
      `  cached input: ${sel.cost.cachedInputTokens} tok → $${sel.cost.cachedInputCost.toFixed(6)}`,
    );
    lines.push(`  output: ${sel.cost.outputTokens} tok → $${sel.cost.outputCost.toFixed(6)}`);
    lines.push(
      `  cache write: ${sel.cost.cacheWriteTokens} tok → $${sel.cost.cacheWriteCost.toFixed(6)}`,
    );
    lines.push(
      `  retry/escalation/latency: $${(sel.cost.expectedRetryCost + sel.cost.expectedEscalationCost + sel.cost.latencyPenalty).toFixed(6)}`,
    );
    lines.push(`Price basis: ${sel.cost.priceBasis}`);
    lines.push(`Deal applied to rates: ${sel.cost.dealApplied}`);
    lines.push(`Success rate prior: ${(sel.successRate * 100).toFixed(1)}%`);
    lines.push(`Avg latency prior: ${sel.averageLatencyMs}ms`);
  }
  lines.push(`Deal affected selection: ${decision.dealAffectedSelection}`);
  lines.push(`Pricing snapshot age: ${Math.round(decision.pricingSnapshotAgeMs / 1000)}s`);
  lines.push(`Pricing retrieved at: ${decision.pricingSnapshotRetrievedAt}`);
  lines.push(`Tie-break: ${decision.tieBreakRule}`);
  lines.push("");
  lines.push("### Candidates (ranked)");
  for (const c of decision.candidates) {
    lines.push(
      `- ${c.modelId}  score=${c.score.toFixed(6)}  cost=$${c.cost.expectedTotalCost.toFixed(6)}  tier=${c.qualityTier}  pref=${c.preferred}`,
    );
  }
  lines.push("");
  lines.push("### Rejected");
  if (decision.rejected.length === 0) lines.push("(none)");
  for (const r of decision.rejected) {
    lines.push(`- ${r.modelId}: ${r.reason}`);
  }
  lines.push("");
  lines.push(`Summary: ${decision.explanation}`);
  lines.push("");
  lines.push("Note: costs are estimates, not observed token billing.");
  return lines.join("\n");
}
