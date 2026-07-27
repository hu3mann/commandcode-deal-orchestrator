# Security Review — CCROUTE-AUTO-2026-001

## Scope

Model switching vs permission mode, prompt interception, unsupported surfaces, exact model validation,
explicit override failure, recursion, Mod compatibility, settings ownership, update/uninstall custody,
launchd plist safety, refresh leases, snapshot replacement, stale promotions, catalog mapping,
agent permissions, memory modification, telemetry leakage, secret redaction, worktree safety.

## Findings

### CRITICAL
None open.

### HIGH
None open.

### MEDIUM
1. **Unverified hook event contracts** — `cmd --help` does not document hooks; hooks remain defence-in-depth only.
2. **Modest branch-coverage margin** — gate is met but eyelash-thin historically; regression risk under new surfaces.

### LOW
1. Agent format is package-defined markdown (not a CommandCode-native documented agent schema); treat as portable docs/helpers.
2. Optional AGENTS.md memory must not be claimed as deterministic enforcement (documented).

### INFORMATIONAL
1. Live catalog reconciliation intentionally refuses rate transfer on ambiguous matches.
2. Project agents force `model: inherit` for portability.

## Verdict

No open Critical or High findings. Ready for `PASS_WITH_LIMITATIONS` series acceptance when live smoke is unauthorized.
