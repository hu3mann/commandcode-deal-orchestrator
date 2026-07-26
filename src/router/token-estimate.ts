import type { RoutingConfig } from "../config/schemas.js";
import type { ClassifiedTask } from "../domain/task.js";
import type { TokenEstimate } from "../pricing/calculator.js";

/**
 * Single source of truth for turning a classified task + its task-class token priors into
 * a TokenEstimate. Both router/eligibility.ts (the §17 context-window hard gate,
 * CCROUTE-001 defect 1) and router/scorer.ts (cost estimation) call this — the defect
 * report is explicit that context estimation must reuse the existing estimator rather than
 * inventing a second one.
 */
export function estimateRequestTokens(task: ClassifiedTask, config: RoutingConfig): TokenEstimate {
  const taskPolicy = config.task_classes[task.taskClass];
  if (!taskPolicy) {
    throw new Error(`Missing task class policy for ${task.taskClass}`);
  }
  const priors = taskPolicy.token_priors;
  return {
    freshInput: Math.max(priors.freshInput, Math.ceil(task.cleanedText.length / 4)),
    cachedInput: priors.cachedInput,
    output: priors.output,
    cacheWrite: priors.cacheWrite,
  };
}

/**
 * Total context tokens implied by a TokenEstimate: fresh + cached input + output. Matches
 * the same formula pricing/calculator.ts#resolveEffectiveRates uses to pick a rate tier
 * when no explicit `estimatedContext` override is supplied, so the eligibility gate and
 * the pricing-tier lookup never disagree about what "the estimated context" means.
 */
export function estimateContextTokens(tokens: TokenEstimate): number {
  return tokens.freshInput + tokens.cachedInput + tokens.output;
}
