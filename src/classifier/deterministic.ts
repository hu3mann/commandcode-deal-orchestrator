import type { ClassifiedTask, RiskLevel, TaskClass, TaskOverride } from "../domain/task.js";
import {
  BUILD_SIGNALS,
  COMPLEXITY_SIGNALS,
  HIGH_RISK_SIGNALS,
  READ_ONLY_SIGNALS,
  TRIVIAL_EDIT_SIGNALS,
  matchSignals,
} from "./signals.js";

const MARKER_RE = /(?:^|\s)!(cheap|balanced|frontier|no-free|model=([^\s]+))(?=\s|$)/gi;

export function parseTaskMarkers(text: string): { cleaned: string; overrides: TaskOverride } {
  const overrides: TaskOverride = {};
  const cleaned = text
    .replace(MARKER_RE, (_, token: string, modelId?: string) => {
      const t = token.toLowerCase();
      if (t === "cheap") overrides.profile = "cheapest";
      else if (t === "balanced") overrides.profile = "balanced";
      else if (t === "frontier") overrides.profile = "frontier";
      else if (t === "no-free") overrides.noFree = true;
      else if (t.startsWith("model=") && modelId) overrides.model = modelId;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return { cleaned, overrides };
}

export interface RepoSignals {
  trackedFiles?: number;
  languages?: string[];
  monorepo?: boolean;
  packageCount?: number;
  hasMigrations?: boolean;
  hasAuthModules?: boolean;
  hasInfra?: boolean;
  dirtyWorktree?: boolean;
}

export function classifyTask(text: string, repo: RepoSignals = {}): ClassifiedTask {
  const { cleaned, overrides } = parseTaskMarkers(text);
  const readHits = matchSignals(cleaned, READ_ONLY_SIGNALS);
  const complexHits = matchSignals(cleaned, COMPLEXITY_SIGNALS);
  const riskHits = matchSignals(cleaned, HIGH_RISK_SIGNALS);
  const trivialHits = matchSignals(cleaned, TRIVIAL_EDIT_SIGNALS);
  const buildHits = matchSignals(cleaned, BUILD_SIGNALS);

  const signals = [
    ...readHits.map((s) => `read:${s}`),
    ...complexHits.map((s) => `complex:${s}`),
    ...riskHits.map((s) => `risk:${s}`),
    ...trivialHits.map((s) => `trivial:${s}`),
    ...buildHits.map((s) => `build:${s}`),
  ];

  if (repo.monorepo) signals.push("repo:monorepo");
  if (repo.hasMigrations) signals.push("repo:migrations");
  if (repo.hasAuthModules) signals.push("repo:auth");
  if (repo.hasInfra) signals.push("repo:infra");
  if ((repo.trackedFiles ?? 0) > 500) signals.push("repo:large");
  if ((repo.packageCount ?? 0) > 3) signals.push("repo:multi-package");

  let riskLevel: RiskLevel = "low";
  if (riskHits.length > 0 || repo.hasAuthModules || repo.hasMigrations) {
    riskLevel = "high";
  } else if (complexHits.length > 0 || repo.monorepo) {
    riskLevel = "medium";
  }

  let taskClass: TaskClass;
  const reviewIntent = /\b(review|audit|harden|secure)\b/i.test(cleaned);
  const changeIntent =
    buildHits.length > 0 ||
    /\b(fix|implement|add|create|update|migrate|deploy|rewrite|replace)\b/i.test(cleaned);

  // High-risk review: security domain + review/change intent (short prompts still count)
  if (riskLevel === "high" && riskHits.length > 0 && (reviewIntent || changeIntent)) {
    taskClass = "high_risk_review";
  } else if (
    complexHits.some((s) => s.includes("architecture") || s.includes("redesign")) ||
    /\barchitecture\b/i.test(cleaned)
  ) {
    taskClass = "architecture";
  } else if (
    complexHits.length >= 2 ||
    (complexHits.length >= 1 && buildHits.length >= 1) ||
    repo.monorepo ||
    (repo.trackedFiles ?? 0) > 800
  ) {
    taskClass = "complex_build";
  } else if (changeIntent) {
    if (trivialHits.length > 0 && complexHits.length === 0 && riskLevel === "low") {
      taskClass = "trivial_edit";
    } else if (riskLevel === "high" && riskHits.length > 0) {
      taskClass = "high_risk_review";
    } else {
      taskClass = "standard_build";
    }
  } else if (trivialHits.length > 0) {
    taskClass = "trivial_edit";
  } else if (readHits.length > 0 || cleaned.length < 40) {
    taskClass = "read_only";
  } else {
    taskClass = "standard_build";
  }

  // Keep elevated risk on security topics even for pure read-only explains
  if (riskHits.length > 0) {
    riskLevel = "high";
  }

  const requiredCapabilities: string[] = [];
  if (taskClass === "architecture" || taskClass === "high_risk_review") {
    requiredCapabilities.push("strong_reasoning");
  }
  if (taskClass === "complex_build" || taskClass === "standard_build") {
    requiredCapabilities.push("agentic_coding");
  }
  if (riskLevel === "high") requiredCapabilities.push("careful_review");

  return {
    originalText: text,
    cleanedText: cleaned,
    taskClass,
    riskLevel,
    signals,
    overrides,
    requiredCapabilities,
  };
}
