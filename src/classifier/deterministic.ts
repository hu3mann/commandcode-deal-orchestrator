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
  // Word-boundary matching for risk keywords: several mandated keywords (e.g. "token",
  // "secret") are short substrings of unrelated words ("tokenize", "secretary"). See the
  // matchSignals doc comment in signals.ts for the exact matching semantics.
  const riskHits = matchSignals(cleaned, HIGH_RISK_SIGNALS, { wordBoundary: true });
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

  // Risk level is fully finalized here, BEFORE taskClass is derived from it, so that
  // taskClass can never be computed from a stale/pre-risk view of the prompt (defect 2).
  let riskLevel: RiskLevel = "low";
  if (riskHits.length > 0 || repo.hasAuthModules || repo.hasMigrations) {
    riskLevel = "high";
  } else if (complexHits.length > 0 || repo.monorepo) {
    riskLevel = "medium";
  }

  let taskClass: TaskClass;
  const changeIntent =
    buildHits.length > 0 ||
    /\b(fix|implement|add|create|update|migrate|deploy|rewrite|replace)\b/i.test(cleaned);

  // High-risk signals override everything else, including prompt brevity and the
  // absence of a review/change verb (§16.6: "A five-word security task remains high
  // risk."). This check is unconditional and comes first so that riskLevel === "high"
  // can never coexist with a taskClass below the frontier floor (read_only,
  // trivial_edit, standard_build, complex_build) — see the invariant enforced below.
  // Note this takes priority even over the "architecture" keyword: both classes carry
  // the same frontier quality floor, but high_risk_review additionally gets extra
  // routing protections downstream (see src/router/eligibility.ts, which refuses to
  // route high_risk_review to the economical tier even under override) that a plain
  // "architecture" classification would not get. A prompt combining risk and
  // architecture language (e.g. "redesign the auth architecture") therefore now
  // classifies as high_risk_review rather than architecture.
  if (riskLevel === "high") {
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
    if (trivialHits.length > 0 && complexHits.length === 0) {
      taskClass = "trivial_edit";
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

  // Structural invariant (defect 2): high risk must never coexist with a read-only
  // classification. Kept as a hard assertion, not just a comment, so a future change to
  // the branches above that reintroduces the bug fails loudly (tests included).
  if (riskLevel === "high" && taskClass === "read_only") {
    throw new Error(
      `classifier invariant violated: riskLevel=high with taskClass=read_only for cleaned text: ${JSON.stringify(
        cleaned,
      )}`,
    );
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
