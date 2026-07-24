export const READ_ONLY_SIGNALS = [
  "explain",
  "summarize",
  "find",
  "search",
  "inspect",
  "review documentation",
  "list",
  "compare",
  "what is",
  "how does",
  "show me",
  "describe",
] as const;

export const COMPLEXITY_SIGNALS = [
  "repo-wide",
  "multi-file",
  "refactor",
  "redesign",
  "architecture",
  "cross-service",
  "failing ci",
  "unknown regression",
  "race condition",
  "performance",
  "migration",
  "monorepo",
  "across services",
  "three services",
  "multiple packages",
] as const;

export const HIGH_RISK_SIGNALS = [
  "authentication",
  "authorization",
  "permissions",
  "security",
  "secret",
  "credential",
  "encryption",
  "payment",
  "billing",
  "production",
  "deployment",
  "rollback",
  "database migration",
  "schema migration",
  "data loss",
  "destructive",
  "concurrency",
  "public api",
  "compliance",
  "auth middleware",
] as const;

export const TRIVIAL_EDIT_SIGNALS = [
  "typo",
  "rename variable",
  "fix lint",
  "format",
  "one-line",
  "one line",
  "comment only",
] as const;

export const BUILD_SIGNALS = [
  "implement",
  "add feature",
  "fix bug",
  "unit test",
  "write tests",
  "create",
  "update",
  "patch",
] as const;

export function matchSignals(text: string, dictionary: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return dictionary.filter((s) => lower.includes(s.toLowerCase()));
}
