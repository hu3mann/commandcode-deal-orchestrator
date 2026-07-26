# Threat Model — commandcode-deal-orchestrator (`ccroute`)

## Trust assumptions

| Boundary | Trusted | Untrusted |
| --- | --- | --- |
| ccroute process | Yes | — |
| Built-in config defaults | Yes | — |
| User config (`~/.commandcode/deal-router.yaml`) | No | Project operator |
| Project config (`.commandcode/deal-router.yaml`) | No | Repository contributors |
| CLI arguments | No | Caller |
| Task text | No | User, Skill, child process |
| `cmd --list-models` output | Partially | Binary output is assumed accurate; models parsed — ids are then validated |
| Pricing snapshot (disk) | Yes (written by ccroute) | Filesystem permissions |
| Official pricing source (HTTPS) | Yes (TLS) | Network MITM theoretical |
| Role result envelopes | No | Model output — untrusted data |
| Telemetry JSONL | Yes (append-only) | Redaction is defense-in-depth |
| Hooks | Yes (provided files) | Hook JSON payload is parsed safely |
| Child `cmd` processes | No (bounded) | Subprocess with restricted environment |

---

## Threat inventory

### T-001: Shell injection via task text

- **Asset**: Host process
- **Actor**: Malicious task text or rogue Skill
- **Attack**: Embed `` `rm -rf /` `` or `$(curl ...)` in task text that gets interpolated into a shell command
- **Control**: `child_process.spawn(cmd, argv, { shell: false })`; task sent on stdin (`write` to child.stdin), not argv; model ID validated with `assertSafeModelId()` metacharacter filter
- **Residual risk**: None for direct injection — argv is fixed array and shell is false. Input-length exhaustion is bounded by subprocess stdout/stderr limits
- **Verification**: Unit tests with shell metacharacters in task text; integration test with hostile model ID

### T-002: Argument injection via model ID

- **Asset**: Child `cmd` process
- **Actor**: Corrupted config or CLI
- **Attack**: Model ID like `--yolo --auto-accept` injected as a single argv element to bypass write controls
- **Control**: `assertSafeModelId()` rejects `;|&$`<>` and `..` ; `buildCmdArgv()` constructs argv before passing to `spawn`; each argv element is its own string — a model ID containing spaces or dashes is still a single element positioned after `--model`
- **Residual risk**: Low — string passed as one argv element, never concatenated into a command string
- **Verification**: Unit test for `assertSafeModelId` with injection patterns

### T-003: Hostile task text in child environment

- **Asset**: Child CommandCode session
- **Actor**: Repository file, user input, upstream data
- **Attack**: Prompt injection embedded in task text that instructs `cmd` to ignore its constraints, bypass file boundaries, or steal credentials
- **Control**: Role packets include explicit bounded context; environment variables `CCROUTE_CHILD=1` with role instruction; `--print` non-interactive mode; stdout/stderr bounded; telemetry redacted
- **Residual risk**: Medium — `cmd` has its own tool surface. Operator should install PreToolUse hooks to deny `ccroute` and sensitive commands inside child sessions
- **Verification**: Hook tests deny `ccroute` execution in child; child recursion test

### T-004: Recursive orchestration (ccroute → cmd → ccroute → cmd …)

- **Asset**: Process tree, budget
- **Actor**: Task instructing child `cmd` to `ccroute run "..."` again
- **Control**: `assertCcrouteEntryAllowed()` checks `CCROUTE_DEPTH` (rejects >= 2) and `CCROUTE_CHILD=1`; child environment sets `CCROUTE_DEPTH=parent+1`; hooks also deny `ccroute` in child path resolution
- **Residual risk**: Low — depth env var could theoretically be stripped, but hooks provide secondary defence
- **Verification**: Unit tests with env vars set to depth 2 and child=1

### T-005: Model-ID spoofing

- **Asset**: Router decision
- **Actor**: Corrupted config or stale snapshot
- **Attack**: Config references a model ID that no longer exists in the live catalog; router silently uses outdated pricing
- **Control**: Router compares candidate IDs against live `cmd --list-models` set when available; `explain` reports whether live catalog was used; explicit `--model` with unknown ID fails not silently falls back
- **Residual risk**: Low — offline mode uses seed-only catalog with `availability: "unavailable"` markers
- **Verification**: Unit test for unavailable model rejection; `ccroute models refresh` marks missing models unavailable

### T-006: Pricing-source poisoning

- **Asset**: Cost estimation, deal state
- **Actor**: Compromised DNS, MITM, or malicious official-source replacement
- **Control**: Pricing snapshots validated by Zod schema; invalid values (NaN, negative, malformed IDs) rejected; snapshot hash recorded; failed refresh preserves previous valid snapshot; network fetch blocked by default (opt-in `--network`)
- **Residual risk**: Low — TLS protects official source; seed snapshots in package are version-controlled
- **Verification**: Unit test for corrupted snapshot rejection; refresh failure preserving prior

### T-007: Stale deal double discount

- **Asset**: Cost calculation
- **Actor**: Snapshot not refreshed; deal expiry not checked
- **Control**: `resolveEffectiveRates()` uses `post_discount` flag to prevent re-application of promotional multipliers; temporary pricing falls back to `replacementRate` after expiry; free deals excluded after exact expiry instant; `ccroute deals status` reports expired deals
- **Residual risk**: Low — timezone-aware timestamps used; hard unit test for double discount
- **Verification**: Unit test: "no double promo discount" with pre/post discount fixtures

### T-008: Telemetry leakage

- **Asset**: Source code, credentials in task text
- **Actor**: Unintentional logging of full task text or model output
- **Control**: Telemetry stores task hash, coarse metadata, model ID, latency — not full task text or source file bodies; `--no-telemetry` flag; `redact.ts` scans for common secret patterns (API keys, tokens, passwords)
- **Residual risk**: Low — task text is not stored by default; redaction is defence-in-depth
- **Verification**: Unit test for secret pattern redaction

### T-009: Credential leakage via child process

- **Asset**: API keys, tokens
- **Actor**: Child `cmd` process or its output
- **Attack**: `cmd` might emit credentials in response to hostile prompt; ccroute redacts before persisting
- **Control**: Telemetry redaction scans `redact.ts` patterns; `maxResultBytes` bounds output capture; no credential storage by ccroute itself; child environment stripped of unnecessary secrets
- **Residual risk**: Low — child `cmd` has its own auth (oauth or API key), not managed by ccroute
- **Verification**: Integration test with fake credential patterns in child stdout

### T-010: Unsafe fallback from explicit model

- **Asset**: User expectation, budget
- **Actor**: Explicit `--model` request to unavailable model
- **Attack**: User pins a specific model; the router silently substitutes a different one, so the user pays for or trusts a model they did not choose
- **Control**: Router fails closed when explicit model is unavailable or ineligible — exit 11 (`MODEL_UNAVAILABLE`); no silent fallback to a different model for an explicit request
- **Residual risk**: None — explicitly tested
- **Verification**: Integration test for explicit model failure

### T-011: Dirty worktree mutation

- **Asset**: Repository state
- **Actor**: User runs `run --apply` or `orchestrate --apply` on an already-dirty tree
- **Attack**: Run mutates a tree that already has uncommitted user work, making the run's changes indistinguishable from the user's and unrecoverable by `git checkout`
- **Control**: `ensureGitSafety()` rejects dirty worktree for any `--apply` unless `--allow-dirty`; non-git dirs skip the gate
- **Residual risk**: Low — override is explicit; read-only runs never gated
- **Verification**: Unit tests for dirty rejection on run and orchestrate contexts

### T-012: Symlink path escape

- **Asset**: Files outside project root
- **Actor**: Project with symlink to sensitive directory
- **Attack**: `run` writes files through symlink to `~/.ssh/` or similar
- **Control**: `assertPathInsideRoot()` in `src/security/path-policy.ts` resolves BOTH operands with `realpathSync` before comparing, so a symlink pointing outside the root is rejected rather than passing a naive string-prefix check. Wired into run-artifact path validation in `src/cli.ts`.
- **Residual risk**: Low — ccroute itself writes only run artifacts; arbitrary file writes are `cmd`'s responsibility and outside this boundary.
- **Verification**: Unit tests for path escape rejection in `tests/unit/security.test.ts`.
- **Correction (2026-07-26 audit)**: this entry previously credited a function `isPathWithinAllowed()` and a file `file-boundary.ts`. **Neither ever existed.** The real function, `assertPathInsideRoot`, was correct but had zero call sites in `src/` — it was exercised only by its own unit test. The control is now genuinely wired.

### T-013: Oversized child output

- **Asset**: Memory, disk
- **Actor**: Model produces infinite output stream
- **Attack**: A runaway or adversarial child streams unbounded stdout, exhausting host memory or filling the disk with run artifacts
- **Control**: `maxStdoutBytes` and `maxStderrBytes` bounds on subprocess output capture; timeout kills process group
- **Residual risk**: Low — output is truncated at configured limit, not held unbounded
- **Verification**: Unit test for stdout limit enforcement

### T-014: Hanging subprocess

- **Asset**: Process table, user experience
- **Actor**: Model stalls or hangs
- **Attack**: Child never exits, holding a process slot and blocking the run indefinitely; a naive kill leaves orphaned grandchildren
- **Control**: Configurable `timeoutMs` (default 300s); `AbortController` + `kill` process group on POSIX
- **Residual risk**: Low — best-effort kill-tree on POSIX; timeout is configurable
- **Verification**: Integration test with timeout shorter than expected completion

### T-015: Role-envelope spoofing

- **Asset**: Orchestration logic
- **Actor**: Model returns malicious envelope pretending to accept or reject a plan
- **Attack**: Child emits a forged or duplicated result envelope to force an ACCEPT, skip review, or smuggle an unintended decision past the orchestrator
- **Control**: Role result parsed with bounded envelope regex; Zod schema validation; fields validated semantically; one format repair attempt only; untrusted data never executed
- **Residual risk**: Low — envelope is bounded (schema-trimmed); results are advisory, not authoritative
- **Verification**: Unit test for second invalid envelope → fail closed

### T-016: Project config poisoning

- **Asset**: Routing policy, allowed models
- **Actor**: Attacker contributes to repo and modifies `.commandcode/deal-router.yaml`
- **Attack**: A committed project config alters routing policy, quality floors, or security-relevant keys for anyone who runs ccroute in that checkout
- **Control**: Config malformed → fail closed; unknown security-sensitive keys rejected; Zod validates all numeric bounds, date formats, model IDs; no credential storage in config
- **Residual risk**: Medium — a project config can set `minimum_tier: economical` for all classes to encourage cheap routing, but cannot inject arbitrary commands. User-level config overrides project
- **Verification**: Unit test for malformed YAML, unknown keys, invalid values

### T-017: Arbitrary executable path

- **Asset**: Subprocess execution
- **Actor**: Config specifies `cmdPath` pointing to a malicious binary
- **Attack**: A project-scope config sets `cmdPath` to an attacker-supplied script; any ccroute command — including read-only `decide` — executes it
- **Control**: `cmdPath` is **rejected outright in project-scope config** (`PROJECT_FORBIDDEN_KEYS`, enforced in `src/config/merge.ts`) — it is accepted only from user-scope config. `resolveCmdPath()` additionally resolves with `realpathSync`, requires a regular file with the executable bit set, rejects relative paths and paths inside the current working directory, and prefers a PATH lookup over any caller-supplied path.
- **Residual risk**: Low — a user-scope config is already inside the user's trust boundary. `cmdPath` no longer overrides a `cmd` found on PATH; it acts only as a fallback.
- **Verification**: `tests/unit/security-extra.test.ts` covers project-scope rejection end to end (writes a real `.commandcode/deal-router.yaml`), plus relative-path, directory, non-executable and inside-cwd rejection. Re-verified against the original exploit: both absolute and relative variants now fail closed with `CONFIG_INVALID`.
- **Correction (2026-07-26 audit)**: this entry previously rated the risk "Low" against a control that **did not exist**. `resolveCmdPath` checked only `existsSync`. A project-local `.commandcode/deal-router.yaml` setting `cmdPath: ./evil.sh` achieved arbitrary code execution through `ccroute decide` — the read-only command — with no `--apply` and no prompt. This was a live, demonstrated RCE, not a theoretical one, and was rated Low precisely because nobody tested the claim.

### T-018: Prompt injection from repository files

- **Asset**: Child role sessions, orchestration decisions
- **Actor**: Any contributor to the repository under analysis
- **Attack**: A source file, comment, README or fixture contains text addressed to the model ("ignore your constraints", or a forged `BEGIN_CCROUTE_RESULT` block). The Executor or Reviewer reads it while working and treats it as instruction rather than data.
- **Control**: Role packets are bounded and structured (`maxPromptBytes`, enforced in `src/orchestration/packet.ts`); role output is parsed only as a single schema-validated envelope; **multiple envelopes are rejected** rather than last-wins, closing the path where echoed file content overrides a genuine `BLOCKED` with an injected `ACCEPT`; deterministic validation gates success independently of any model's opinion.
- **Residual risk**: **Medium.** `cmd` retains its own tool surface inside a child session; ccroute bounds what it sends and how it interprets what comes back, but cannot police what the child does with repository text it reads itself. Operator-installed PreToolUse hooks are the mitigation, and those are unverified against the installed CLI (see T-021).
- **Verification**: `tests/unit/orchestration.test.ts` covers injected-second-envelope rejection; `tests/unit/orchestration-flow.test.ts` proves a failing validation gate cannot be overridden by a Reviewer ACCEPT.

### T-019: Arbitrary provider URLs

- **Asset**: Credentials, request destination
- **Actor**: Project config, or a future provider adapter
- **Attack**: Config supplies an arbitrary base URL so requests — and any attached credentials — are sent to an attacker-controlled endpoint.
- **Control**: The MVP has **no configurable provider URL**. The only network egress is the official pricing source in `src/pricing/refresh.ts`, which is opt-in (`--network`) and validates both response status and content type. The optional xAI adapter (§33) is not implemented; the packet requires it to reject arbitrary base URLs when it is.
- **Residual risk**: Low today, because the capability does not exist. This entry exists so the constraint is on record **before** the xAI adapter is built.
- **Verification**: No provider-URL config field exists (`grep` for a base-URL setting returns nothing); content-type validation is covered in `tests/unit/official-html.test.ts`.

### T-020: Malicious model output

- **Asset**: Filesystem, orchestration control flow, operator trust
- **Actor**: A compromised, adversarial or simply malfunctioning model
- **Attack**: Output contains a path traversal in `artifacts[]`, a shell snippet the operator is invited to run, a URL to fetch, or a forged decision intended to skip review.
- **Control**: Role results are Zod-validated and treated strictly as data. No field from model output is used as a filesystem path, URL, or command anywhere in the codebase (verified by exhaustive grep). Artifact writes are redacted via `redactText` and path-checked via `assertPathInsideRoot`. Success is gated by deterministic validation, not by the model's self-report.
- **Residual risk**: Low — model output influences reporting, not execution.
- **Verification**: Envelope schema and semantic validation tests; the end-to-end proof that a Reviewer ACCEPT cannot pass a failing gate.

### T-021: Unverified hook contract

- **Asset**: The recursion control's secondary layer
- **Actor**: Version drift between CommandCode's documented and actual hook interface
- **Attack**: Not an attack so much as a false assurance: the hook silently never fires, so a control counted as present provides nothing.
- **Control**: None available. The hook event names, the `PreToolUse` matcher value, and the deny-JSON shape are taken from documentation. `cmd --help` on the installed v1.4.1 contains **zero** mentions of hooks (`grep -ci hook evidence/commandcode-help.txt` → 0).
- **Residual risk**: **Medium, accepted.** Hooks are unverified defence-in-depth. The primary recursion control is the environment guard in `src/security/recursion-guard.ts`, which is itself bypassable by a child that strips its own environment (`env -u CCROUTE_CHILD ...`). Closing that would require a parent-held capability token or OS-level sandboxing; neither is in the MVP.
- **Verification**: Hook behavior is tested against fixtures (`tests/unit/hooks.test.ts`), which proves our scripts behave correctly **given** the assumed payload shape — not that CommandCode ever sends it.
- **Correction (2026-07-26 audit)**: the previous `SECURITY-REVIEW.md` counted hooks toward a "Recursion blocked — PASS" row. That was not supportable.

---

## Summary

Severity is the impact if the control fails. "Controlled" reflects what is **verified by
test or reproduction**, not what is intended.

| Threat | Severity | Controlled | Residual |
| --- | --- | --- | --- |
| T-001 Shell injection | Critical | Yes | None |
| T-002 Argument injection | High | Yes | Low |
| T-003 Hostile task in child | High | Partial | Medium |
| T-004 Recursive orchestration | High | Partial | Medium |
| T-005 Model-ID spoofing | Medium | Yes | Low |
| T-006 Pricing-source poisoning | Medium | Yes | Low |
| T-007 Stale deal double discount | Medium | Yes | Low |
| T-008 Telemetry leakage | Medium | Yes | Low |
| T-009 Credential leakage | Medium | Partial | Low |
| T-010 Unsafe fallback | Medium | Yes | None |
| T-011 Dirty worktree mutation | Low | Yes | Low |
| T-012 Symlink path escape | Low | Yes | Low |
| T-013 Oversized child output | Low | Yes | Low |
| T-014 Hanging subprocess | Low | Yes | Low |
| T-015 Role-envelope spoofing | Medium | Yes | Low |
| T-016 Project config poisoning | High | Yes | Low |
| T-017 Arbitrary executable path | **Critical** | Yes | Low |
| T-018 Prompt injection from repo files | High | Partial | Medium |
| T-019 Arbitrary provider URLs | Medium | N/A — capability absent | Low |
| T-020 Malicious model output | Medium | Yes | Low |
| T-021 Unverified hook contract | Medium | **No** | Medium, accepted |

### Accepted residual risks

Three items are knowingly left open rather than marked controlled:

1. **T-021 / T-004 — the recursion guard is bypassable.** The environment guard is
   defeated by a child that strips its own environment. The hook layer that was meant
   to be the second line of defence is unverified against the installed CLI. Closing
   this needs a parent-held capability token or OS sandboxing.
2. **T-003 / T-018 — the child's tool surface is not ours to police.** ccroute bounds
   what it sends and how it reads what comes back; it cannot constrain what `cmd` does
   with repository text it reads on its own.
3. **Capability-based eligibility (§17) is inert.** The gate is implemented and tested,
   but no catalog supplies capability data, so it currently matches nothing. Populating
   it with invented values would violate §13; it stays inert until an authoritative
   source exists.

### Audit history

Rewritten 2026-07-26 following an independent audit (`AUDIT-REPORT.md`). The prior
version documented 17 threats and closed with "All critical- and high-severity threats
are controlled with verified measures." That statement was false: T-017 credited a
control that did not exist and was rated Low while a live, reproducible RCE was
reachable through `ccroute decide`, and T-012 cited a function and a file that were
never written. Four required threats were missing entirely and seven entries lacked an
`Attack:` field. Severity and "Controlled" columns above have been re-derived from
tests and reproductions rather than from intent.
