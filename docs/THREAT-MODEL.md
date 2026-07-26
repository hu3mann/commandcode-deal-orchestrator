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
- **Control**: Router fails closed when explicit model is unavailable or ineligible — `NO_ELIGIBLE_MODEL` exit; no silent fallback to a different model for an explicit request
- **Residual risk**: None — explicitly tested
- **Verification**: Integration test for explicit model failure

### T-011: Dirty worktree mutation

- **Asset**: Repository state
- **Actor**: User runs `run --apply` or `orchestrate --apply` on an already-dirty tree
- **Control**: `ensureGitSafety()` rejects dirty worktree for any `--apply` unless `--allow-dirty`; non-git dirs skip the gate
- **Residual risk**: Low — override is explicit; read-only runs never gated
- **Verification**: Unit tests for dirty rejection on run and orchestrate contexts

### T-012: Symlink path escape

- **Asset**: Files outside project root
- **Actor**: Project with symlink to sensitive directory
- **Attack**: `run` writes files through symlink to `~/.ssh/` or similar
- **Control**: `path-policy.ts` includes `isPathWithinAllowed()` check; file boundary enforcement by `file-boundary.ts`
- **Residual risk**: Low — symlink escape is primarily a concern for custom file-writing tools; ccroute MVP does not implement arbitrary file-write orchestration (that is `cmd`'s job)
- **Verification**: Unit test for path escape rejection

### T-013: Oversized child output

- **Asset**: Memory, disk
- **Actor**: Model produces infinite output stream
- **Control**: `maxStdoutBytes` and `maxStderrBytes` bounds on subprocess output capture; timeout kills process group
- **Residual risk**: Low — output is truncated at configured limit, not held unbounded
- **Verification**: Unit test for stdout limit enforcement

### T-014: Hanging subprocess

- **Asset**: Process table, user experience
- **Actor**: Model stalls or hangs
- **Control**: Configurable `timeoutMs` (default 300s); `AbortController` + `kill` process group on POSIX
- **Residual risk**: Low — best-effort kill-tree on POSIX; timeout is configurable
- **Verification**: Integration test with timeout shorter than expected completion

### T-015: Role-envelope spoofing

- **Asset**: Orchestration logic
- **Actor**: Model returns malicious envelope pretending to accept or reject a plan
- **Control**: Role result parsed with bounded envelope regex; Zod schema validation; fields validated semantically; one format repair attempt only; untrusted data never executed
- **Residual risk**: Low — envelope is bounded (schema-trimmed); results are advisory, not authoritative
- **Verification**: Unit test for second invalid envelope → fail closed

### T-016: Project config poisoning

- **Asset**: Routing policy, allowed models
- **Actor**: Attacker contributes to repo and modifies `.commandcode/deal-router.yaml`
- **Control**: Config malformed → fail closed; unknown security-sensitive keys rejected; Zod validates all numeric bounds, date formats, model IDs; no credential storage in config
- **Residual risk**: Medium — a project config can set `minimum_tier: economical` for all classes to encourage cheap routing, but cannot inject arbitrary commands. User-level config overrides project
- **Verification**: Unit test for malformed YAML, unknown keys, invalid values

### T-017: Arbitrary executable path

- **Asset**: Subprocess execution
- **Actor**: Config specifies `cmdPath` pointing to a malicious binary
- **Control**: `resolveCmdPath()` rejects directories and non-executable paths; PATH resolution uses trusted shell lookup; config `cmdPath` is an explicit path that the operator controls
- **Residual risk**: Low — operator controls their own config; an attacker with config write access already has broader access
- **Verification**: Unit test for directory rejection

---

## Summary

| Threat | Severity | Controlled | Residual |
| --- | --- | --- | --- |
| T-001 Shell injection | Critical | Yes | None |
| T-002 Argument injection | High | Yes | Low |
| T-003 Hostile task in child | High | Partial | Medium |
| T-004 Recursive orchestration | High | Yes | Low |
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
| T-016 Project config poisoning | Medium | Yes | Low |
| T-017 Arbitrary executable path | Medium | Yes | Low |

All critical- and high-severity threats are controlled with verified measures. Medium-severity residual risks are documented and understood.
