import { createHash } from "node:crypto";

/**
 * §32 secret-redaction patterns.
 *
 * IMPORTANT — this is a SECONDARY defence, not a guarantee. Regex matching over
 * plain strings cannot reliably find every secret shape: it will miss anything
 * split across a chunk boundary, base64/url-encoded, wrapped in unexpected
 * quoting, or using a vendor key format not enumerated below (key formats
 * change over time without notice). It will also occasionally over-match
 * (e.g. redacting a non-secret value that merely looks like `token: foo`).
 * The primary defence MUST remain not capturing secrets into telemetry or run
 * artifacts in the first place (see §30 minimization) — do not rely on this
 * module alone and do not represent it as a perfect filter anywhere in docs,
 * UI copy, or code comments.
 *
 * As of this fix, `redactText` is called in exactly one place in the codebase:
 * `src/telemetry/store.ts` (`appendTelemetry`), and only over `event.meta`
 * string values. Run artifacts (`orchestrator.ts` writes raw child stdout to
 * `<role>-raw-<n>.txt` unredacted) and any stdout/stderr surfaced by `cli.ts`
 * are NOT covered by this function unless those files are updated to call it
 * too — see the audit report for the specific call sites that still need
 * wiring up.
 */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private key blocks (RSA/EC/OPENSSH/PKCS8/etc). Must run before the
  // generic patterns below since key material inside a PEM block can also
  // trip other rules; matching the whole block first redacts it cleanly.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,

  // Anthropic API keys, e.g. sk-ant-api03-<...>. The character class MUST
  // include `-` and `_`: real Anthropic keys are hyphen-delimited
  // (sk-ant-api03-...), and a class of only [a-z0-9] stops matching at the
  // very first hyphen (after "sk"), so the old pattern only ever matched a
  // 2-character "sk-" prefix and never actually redacted a real key.
  /\bsk-ant-[a-z0-9_-]{10,}/gi,

  // OpenAI API keys: legacy `sk-<...>` and newer `sk-proj-<...>` / scoped
  // (`sk-svcacct-`, etc.) forms. Same hyphen/underscore fix as above. This is
  // intentionally broad enough to also catch any other `sk-`-prefixed vendor
  // key not explicitly enumerated (better to over-redact a look-alike than
  // miss a real credential).
  /\bsk-(?:proj-|svcacct-)?[a-z0-9_-]{10,}/gi,

  // xAI API keys, e.g. xai-<...>.
  /\bxai-[a-z0-9_-]{10,}/gi,

  // GitHub tokens: ghp_ (PAT classic), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server), ghr_ (refresh), and fine-grained github_pat_.
  /\bgh[oprsu]_[a-z0-9]{20,}/gi,
  /\bgithub_pat_[a-z0-9_]{20,}/gi,

  // Bearer tokens, e.g. `Authorization: Bearer <token>` or bare `bearer <token>`.
  /\bbearer\s+[a-z0-9._-]+/gi,

  // Authorization header, any scheme (Basic, Digest, Bearer, custom, or a
  // bare value). Redacts the remainder of the line after the header name so
  // whatever scheme/credential follows is covered even if not explicitly
  // enumerated above.
  /\bauthorization\s*:\s*[^\n\r]+/gi,

  // Cookie / Set-Cookie headers, which routinely carry session tokens.
  /\b(?:set-)?cookie\s*:\s*[^\n\r]+/gi,

  // Generic api-key / token / secret / credential assignments, e.g.
  // `api_key: xxx`, `apiKey=xxx`, `access_token: xxx`, `credential=xxx`.
  // This is also what catches CommandCode's own credentials/config secrets
  // (e.g. `CCROUTE_TOKEN=...`, `cc_api_key: ...`) since there is no single
  // fixed literal prefix for those the way there is for sk-/ghp_/xai-.
  //
  // Deliberately no leading `\b` before the keyword: `\b` only fires between
  // a word char and a non-word char, so `CCROUTE_TOKEN=...` (an underscore,
  // itself a word char, immediately before "TOKEN") would NOT match with a
  // `\btoken` anchor. Env-var-style `PREFIX_TOKEN=` naming is the common
  // case for exactly this kind of secret, so the anchor is dropped here.
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|credentials?)\s*[:=]\s*\S+/gi,

  // Password assignments, e.g. `password: hunter2`, `password=hunter2`.
  // No leading `\b` for the same reason as the token/secret rule above:
  // env/config-style names like `DB_PASSWORD=...` have a word character
  // immediately before "password", so a `\b` anchor would silently fail
  // to match exactly the env-var-naming case that matters most in practice.
  /password\s*[:=]\s*\S+/gi,
];

export function redactText(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

/**
 * Deterministically (one-way) hashes a filesystem path so it can be
 * correlated across telemetry events without persisting the raw path, which
 * can itself leak a username, project name, or directory layout.
 *
 * Previously this function was a no-op (`return p`) despite its name
 * claiming to hash — a straight pass-through, not a hash. It now genuinely
 * hashes via SHA-256 (truncated to 16 hex chars, which is enough to
 * de-duplicate/correlate without being practically reversible for this use
 * case). NOTE: as of this fix there is still no caller — no code path in
 * telemetry/subprocess currently logs a raw path that needs hashing. Any
 * future code that wants to log `cwd` or a file path to telemetry should call
 * this explicitly rather than logging the raw string.
 */
export function hashPath(p: string): string {
  return createHash("sha256").update(p).digest("hex").slice(0, 16);
}
