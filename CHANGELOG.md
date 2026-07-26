# Changelog

## 0.2.0 — 2026-07-26 — audit remediation (first npm release)

Version 0.1.0 was never published to npm; it existed only as a git state. This is
released as 0.2.0 rather than 0.1.0 so that the audited-and-fixed code can never be
confused with the vulnerable 0.1.0 that anyone may have cloned from GitHub.

**Breaking relative to git 0.1.0:** exit codes follow the §11 taxonomy instead of a
catch-all 1; `doctor` DEGRADED now exits 0; `cmdPath` in project config is rejected
rather than honoured; high-risk task text overrides prompt brevity, so some tasks route
to a higher tier than before; `CandidateScore.successRate` is smoothed rather than raw.

An independent audit (`AUDIT-REPORT.md`) found 14 defect classes, including a
confirmed arbitrary-code-execution path and a coverage configuration that hid
49.5% of the codebase. This entry records the remediation.

### Security

- **Fixed arbitrary code execution via project-scope `cmdPath`.** A project-local
  `.commandcode/deal-router.yaml` could point `cmdPath` at any script and have it
  executed by `ccroute decide` — the read-only command — with no flags and no
  prompt. `cmdPath` is now rejected in project scope, and executable resolution
  requires realpath, a regular file, and the executable bit.
- Model IDs beginning with `-` are rejected (argument-injection primitive).
- Recursion hook denies regardless of tool name and matches `node dist/cli.js`;
  an unparsable `CCROUTE_DEPTH` now fails closed.
- Redaction patterns fixed: the Anthropic pattern never matched real keys, and
  env-var-style assignments were missed. Added GitHub, cookie, Authorization and
  PEM patterns. Redaction is now applied to run artifacts, not just telemetry.
- `assertPathInsideRoot` wired into artifact writes; it previously had zero call
  sites despite being credited as a control in the threat model.

### Routing correctness

- Added five mandated high-risk keywords that were absent (`access control`,
  `permission`, `privacy`, `keychain`, `token`), and made high risk override
  prompt brevity — `"rotate the secret"` classified as `read_only` before.
- Implemented the context-window eligibility gate; the capability gate is wired
  and tested but inert until a catalog supplies capability data.
- The live model catalog now fails closed when unreadable instead of treating
  every seed model as live-verified.
- Success rate is smoothed, so one failure no longer zeroes it.
- Tie-break is a real 5-step total order including preference rank, applied to
  every profile.
- Seven hardcoded scoring coefficients moved into config and surfaced by `explain`.

### Pricing

- `sourceHash` is verified on load; seeds carry real SHA-256 digests.
- Added the §14 rate/deal taxonomy, `startsAt` gating, and a **real**
  double-discount guard — the previous one was a comment, and its test passed
  whether or not any guard existed.
- Fixed inverted temporary/permanent deal classification.
- Freshness thresholds are enforced, not merely reported.
- Content-type validation on refresh; transactional two-file commit with fsync.

### Orchestration

- Added a deterministic validation gate between Executor and Reviewer, and made
  it authoritative: a Reviewer `ACCEPT` can no longer pass a run whose tests
  failed. Previously the model was the sole judge of success.
- Advisor independence fails closed instead of silently reusing the planner's
  model when no alternate exists.
- `maxRepairs` and `maxPromptBytes` are enforced; both were dead config knobs.
- Multiple result envelopes are rejected rather than last-wins.
- Manifests are written on every terminal path, atomically, with §31 filenames.

### CLI

- Implemented the §11 exit-code taxonomy; exit 1 is no longer a catch-all.
- Added `explain --json`, `--config`, `models status`, `--commit`, `stats --since`,
  `--skip-validation`, `--max-plan-revisions`, `--max-repairs`, and the missing
  `--json` variants.
- `doctor` reports version, snapshot paths, repository state, warnings and a
  HEALTHY/DEGRADED/BLOCKED status.
- Conflicting task-prefix markers are rejected instead of silently resolved.
- Repository signals are populated; they were dead code.

### Testing

- Coverage now measures all of `src/`. Reported figures moved from a curated
  90.55% over 5 directories to an honest **91.55% lines / 86.95% branches** over
  the whole tree. All eight §35-named areas clear their bar.
- 125 → **408 tests**. `orchestrate()` and `spawnCommandCode()` had never been
  invoked by any test; both now have full coverage.
- Fixed a test that overwrote the real user's `~/.commandcode` pricing snapshot
  on every run.
- Two controls are mutation-tested to prove they are load-bearing.

### Acceptance

- Verdict is **`PASS`**, now supported by a real live smoke run (4/4, $0.0295
  estimated against a $0.25 budget, evidence recorded). The prior `PASS` rested on
  a live-smoke claim with no evidence artifact while a confirmed RCE was open — it
  passed through `PASS_WITH_LIMITATIONS` during remediation and was only restored
  once the run actually happened.
- Threat model rewritten: 17 → 21 threats, all with `Attack:` fields, severities
  re-derived from tests. Two entries credited controls that did not exist.
- `FILE-MANIFEST.json` regenerated with the required `purpose` field (previously
  absent on all 119 entries) and accurate hashes.

## 0.1.0 — 2026-07-23

Initial implementation of `ccroute`: deterministic deal-aware routing, bounded role
orchestration, CommandCode subprocess adapter, telemetry, Skill and hooks.
