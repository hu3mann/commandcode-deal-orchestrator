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
  "access control",
  "permission",
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
  "privacy",
  "keychain",
  "token",
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matching strategy:
 *
 * By default (`wordBoundary: false`, unchanged from the original behavior) this does a
 * plain case-insensitive substring `includes` check. That is fine for the read-only /
 * complexity / trivial / build dictionaries, whose entries are either long enough or
 * distinctive enough (e.g. "repo-wide", "one-line", "unit test") that stray substring
 * matches inside unrelated words are not a real risk.
 *
 * High-risk keywords are different: several are short, common English word fragments
 * that show up as substrings of unrelated words. Naive `includes` would make "secret"
 * fire on "secretary", and "token" fire on "tokenize" or the plural "tokens" (e.g. an
 * LLM-pricing prompt talking about "cheap tokens" is not a security-risk task). To keep
 * those keywords usable without such false positives, callers can pass
 * `wordBoundary: true`, which wraps each keyword in `\b...\b`. A regex `\b` matches at
 * any transition between a word character and a non-word character (including hyphens,
 * spaces, and string start/end), so:
 *   - "rotate the token"  -> `\btoken\b` matches (space boundaries on both sides).
 *   - "auth-token"        -> `\btoken\b` matches (the hyphen is a non-word boundary).
 *   - "tokenize the input" -> `\btoken\b` does NOT match ("n" is directly followed by
 *     the word character "i", so there is no boundary after "token").
 *   - "cheap tokens"      -> `\btoken\b` does NOT match (trailing "s" is a word
 *     character, so there is no boundary after "token"). This is a deliberate
 *     trade-off: it means a prompt that says only "tokens" (plural, no other risk
 *     keyword) will not trip the token signal. Given the packet's stated bias toward
 *     over- rather than under-classifying risk, this is accepted as the one narrowing
 *     case; every other mandated keyword (including the singular "permission" beside
 *     the existing "permissions" entry) still matches via its own dictionary entry.
 *
 * This also incidentally fixes latent false positives in the existing dictionary (e.g.
 * "secret" no longer matches inside "secretary") without weakening detection of any of
 * the verified failing strings in the defect report.
 */
export function matchSignals(
  text: string,
  dictionary: readonly string[],
  options: { wordBoundary?: boolean } = {},
): string[] {
  const lower = text.toLowerCase();
  if (!options.wordBoundary) {
    return dictionary.filter((s) => lower.includes(s.toLowerCase()));
  }
  return dictionary.filter((s) => {
    const pattern = escapeRegExp(s.toLowerCase());
    return new RegExp(`\\b${pattern}\\b`, "i").test(lower);
  });
}
