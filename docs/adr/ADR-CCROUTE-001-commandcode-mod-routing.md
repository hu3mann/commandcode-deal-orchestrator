# ADR-CCROUTE-001: CommandCode Mod Routing

## Status

Accepted for series `CCROUTE-AUTO-2026-001` TP-001.

## Context

Operators want zero-friction interactive routing: ordinary typed prompts should pick a
validated model before the first inference, without an extra LLM classifier request and
without silent repository writes or permission-mode changes.

CommandCode v1.4.1 exposes an experimental but documented `ModApi` with
`hooks.transformInput`, `setModel` / `setEffort`, slash commands, tool hooks, and usage
events.

## Decision

### Primary interactive surface

The **CommandCode Mod** (`src/integrations/commandcode-mod/`) is the primary ordinary
interactive routing surface for typed text prompts.

### Source of truth

**`ccroute` remains the deterministic source of truth.** The Mod:

* calls `ccroute decide --json` (subprocess, `shell: false`) with a hard timeout;
* never embeds pricing formulas or eligibility policy;
* never invents model IDs;
* never uses an LLM to choose a model.

### Prompt surfaces

| Covered | Not covered (explicit fallback) |
| --- | --- |
| Ordinary typed text prompts via `transformInput` | Slash commands (except `/route*`) |
| Session-local `/router-on` / `/router-off` | Image-carrying prompts |
| Explicit markers `!route-off`, `!route-on`, `!cheap`, `!balanced`, `!frontier`, `!model=<id>` | Automated / meta turns |
| | Headless orchestration (`ccroute run` / `orchestrate`) |
| | Untrusted project mods in print mode |

### Compatibility boundaries

* Target API: CommandCode ≥ 1.4.0 as probed on 1.4.1.
* Missing callbacks → Mod loads in degraded mode; warns; CLI remains available.
* Private CommandCode imports are forbidden; only the public `ModApi` shape is used.
* Version-dependent checks live in `compatibility.ts`.

### Route-selection timeout

* Preferred budget: **500 ms**
* Hard maximum: **1500 ms**
* On timeout for automatic routing: keep session model, warn, telemetry failure event.
* Explicit `!model=` override failures **fail closed** (handled message; do not claim success).

### Stale-price behaviour

Inherited from `ccroute` routing policy (snapshot age, expired deals). The Mod does not
treat promotional folklore as current rates.

### Recursion defence layers

1. **Primary (authoritative):** `assertCcrouteEntryAllowed` inside the `ccroute` executable
   entry layer using `CCROUTE_CHILD`, `CCROUTE_DEPTH`, `CCROUTE_ROLE`, `CCROUTE_RUN_ID`.
2. **Mod defence-in-depth:** `beforeToolCall` blocks obvious nested `ccroute` / bin entry
   invocations when `CCROUTE_CHILD=1`, using parsed executable identity (not substring-only).
3. **Optional hooks:** existing `hooks/child-recursion-guard.mjs` remains secondary.

Rules:

```text
CCROUTE_DEPTH missing → 0
CCROUTE_DEPTH = 0 → ordinary invocation allowed
CCROUTE_DEPTH = 1 and CCROUTE_CHILD = 1 → reject external ccroute
CCROUTE_DEPTH > 1 → reject unconditionally
```

No public environment toggle grants nested orchestration to accidental child shells.

### Telemetry ownership

* Append-only store at the configured `telemetry.path` (same schemaVersion 1 events).
* Mod records route decisions, failures, and observed usage from `model_request_*` when present.
* Values labeled OBSERVED / ESTIMATED / UNKNOWN.
* Full prompts are not stored by default.

### CLI fallback

`ccroute decide`, `explain`, `run`, `orchestrate`, and `doctor` remain fully usable without
the Mod.

### Headless limitations

Print mode does not provide ordinary typed-prompt routing. Use CLI commands.

### Permission-mode noninterference

```text
The Mod may select a model.
The Mod may not enable --apply.
The Mod may not change permission mode.
The Mod may not enable auto-accept.
The Mod may not enable YOLO.
The Mod may not launch recursive ccroute orchestration.
```

## Consequences

* Zero-friction only for surfaces `transformInput` can see.
* Install lifecycle, launchd, and role agents are out of scope for TP-001 (later TPs).
* Experimental ModApi may change; pin probed version and degrade gracefully.
