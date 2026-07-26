# Security Review

Date: 2026-07-26 (rewritten after independent audit — see `AUDIT-REPORT.md`)

## How to read this document

The previous version marked thirteen controls `PASS`, including two that did not exist
and one that was defeated by a working exploit. Every row below states what **verifies**
it. A control with no verification is not listed as controlled.

## Controls verified

| Control | Status | Verification |
| --- | --- | --- |
| No shell interpolation | PASS | `spawn(..., {shell:false})`, fixed argv; a task containing `$(touch PWNED)` creates no file (`tests/unit/subprocess.test.ts`) |
| Task text never in argv | PASS | Packet delivered on stdin; asserted against the child's observed argv |
| Executable path hardening | PASS | `cmdPath` rejected in project scope; realpath + regular-file + X_OK checks; relative and inside-cwd paths refused. Original RCE proof-of-concept re-run and blocked |
| Model-ID validation | PASS | Rejects metacharacters, `..`, blank, and **leading-dash** values (`--yolo`, `-y`) |
| Write-bypass flag injection | PASS | `extraArgs` cannot smuggle `--auto-accept` / `--yolo` |
| Apply-gated writes | PASS | `--auto-accept` only with `--apply`; `--unsafe-yolo` requires `--apply`; no config field can enable either |
| Process-group kill on timeout | PASS | A forked grandchild is proven to die, not just the direct child |
| Bounded child output | PASS | stdout/stderr truncated incrementally in the data handlers |
| Dirty-worktree gate | PASS | Enforced for `run --apply` and `orchestrate --apply` unless `--allow-dirty` |
| Fail-closed config | PASS | Malformed project config rejected; security-sensitive keys blocked at every nesting level |
| No silent explicit-model fallback | PASS | Exit 11; eight distinct explicit-model rejection paths each tested |
| Fail-closed live catalog | PASS | An unreadable catalog rejects all models rather than trusting the seed |
| No double discount | PASS | **Mutation-tested** — removing the guard turns the test red |
| Snapshot integrity | PASS | `sourceHash` verified on load; tampered but schema-valid snapshots fall back to seed |
| Deterministic validation authority | PASS | **Mutation-tested** — a Reviewer ACCEPT cannot pass a failing run |
| Advisor independence | PASS | Fails closed (exit 7) when planner and advisor would share a model |
| Envelope spoofing | PASS | Multiple envelopes rejected rather than last-wins; size-bounded |
| Role output never executed | PASS | No model-output field reaches a path, URL, or command (exhaustive grep + tests) |
| Artifact redaction | PASS | `redactText` applied before persistence; paths checked with `assertPathInsideRoot` |
| Secret redaction patterns | PASS | Anthropic/OpenAI/xAI/GitHub/cookie/Authorization/PEM, plus env-var-style assignments |
| Telemetry minimization | PASS | Schema structurally has no task/source/stdout field; secrets in `meta` are redacted |
| Telemetry durability | PASS | Multi-process concurrent append and truncated-final-line recovery both tested |

## Claims corrected during this review

Three statements in the previous review were false. Recorded rather than quietly
amended:

1. **"Recursion blocked — PASS — env depth/child + hooks."** The hook layer is
   unverified against the installed CLI (`cmd --help` on v1.4.1 contains zero mentions
   of hooks). The hook also fired only for tools whose display name matched `/shell/i`,
   so `Bash`/`Execute`/`Terminal` bypassed it entirely, and its match pattern missed
   `node dist/cli.js`. Both hook defects are fixed; the verification gap is not, and is
   now recorded as accepted residual risk (T-021).
2. **Arbitrary executable path — rated "Low, controlled."** It was a live, reproducible
   arbitrary-code-execution path reachable through `ccroute decide`, the read-only
   command. Fixed and regression-tested.
3. **Symlink path escape — credited to `isPathWithinAllowed()` and `file-boundary.ts`.**
   Neither ever existed. The real function, `assertPathInsideRoot`, had zero call sites
   and is now wired in.

## Residual risks

Accepted, not mitigated:

1. **The recursion guard is bypassable.** It is environment-variable based, so a child
   with spawn capability defeats it via `env -u CCROUTE_CHILD …`. The hook layer meant
   to back it up is unverified against the installed CLI. Closing this requires a
   parent-held capability token or OS-level sandboxing — neither is in the MVP.
2. **The child's tool surface is not ours to constrain.** `ccroute` bounds what it sends
   a child and how it interprets what comes back. It cannot police what `cmd` does with
   repository text it reads on its own. Operator-installed PreToolUse hooks are the
   intended mitigation, and are unverified (see 1).
3. **Capability-based eligibility is inert.** Implemented and tested, but no catalog
   supplies capability data. Populating it with invented values would violate the
   "never invent model facts" rule, so it stays inert until an authoritative source
   exists.
4. **Redaction is pattern-based.** It cannot catch encoded, split, or unknown-format
   secrets, and may over-redact. Minimization is the primary defence; redaction is
   secondary. Documented in `src/telemetry/redact.ts`.
5. **Live compatibility unverified.** No live smoke test was run during remediation.

## Verdict

Security acceptance for the MVP: **met under deterministic testing**, with the five
residual risks above explicitly accepted, and unverified live behaviour excluded from
the claim.

This is deliberately narrower than the previous version's unqualified "met".
