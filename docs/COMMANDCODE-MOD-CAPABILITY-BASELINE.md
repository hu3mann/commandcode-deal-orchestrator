# CommandCode Mod Capability Baseline

Series: `CCROUTE-AUTO-2026-001`  
TP: `TP-CCROUTE-AUTO-001`  
Captured: 2026-07-26  
Local CLI: Command Code **v1.4.1** (`command-code@1.4.1`)  
Install path: mise Node 25 global npm (`npm root -g` → `command-code`)  
Auth: not required for API surface inspection  

> Prior baseline (`docs/COMMANDCODE-CAPABILITY-BASELINE.md`) classified
> `setModel()` / `transformInput` as **UNSUPPORTED folklore**. That classification is
> **superseded for Mod surfaces** by the installed v1.4.1 bundled Mod API documentation
> and runnable examples under
> `node_modules/command-code/dist/bundled/mod-builder/`.

## Classification legend

| Status | Meaning |
| --- | --- |
| DOCUMENTED_AND_OBSERVED | Official/bundled docs + present in installed package artifacts |
| DOCUMENTED_NOT_OBSERVED | Documented but not exercised against a live interactive session in this TP |
| OBSERVED_UNDOCUMENTED | Seen in binary/package without stable public docs |
| UNSUPPORTED | Must not be depended on |
| AMBIGUOUS | Partial evidence; fail closed |

## Probes

| Command | Result |
| --- | --- |
| `command -v cmd` | present (mise shim → node global bin) |
| `cmd --version` | `1.4.1` |
| `cmd --help` | includes `--mod`, `--mod-option`, `cmd mods` |
| `cmd --list-models` | 48 models (live) |
| `cmd mods --help` | add/remove/list/update |
| `cmd mods list` | 4 built-in mods; 0 user mods |
| Bundled mod-builder skill | present under `dist/bundled/mod-builder/` |
| `@commandcode/harness` types | consumed by mods at load time via CommandCode’s loader (not a separate published dep of ccroute) |

## Required surfaces (TP-001)

| Surface | Classification | Evidence |
| --- | --- | --- |
| `hooks.transformInput` | DOCUMENTED_AND_OBSERVED | `reference/api.md`, `examples/input-shortcuts.ts`, kitchen-sink |
| `cmd.setModel(value)` | DOCUMENTED_AND_OBSERVED | `reference/api.md` live methods; buffered pre-bind |
| `cmd.setEffort(value)` | DOCUMENTED_AND_OBSERVED | same table as `setModel` |
| `cmd.addCommand` / slash commands | DOCUMENTED_AND_OBSERVED | api.md + `examples/slash-command.ts` |
| `model_request_start` | DOCUMENTED_AND_OBSERVED | hooks-and-events AgentEvent catalog (`{model}`) |
| `model_request_end` | DOCUMENTED_AND_OBSERVED | catalog (`{model, usage, stopReason}`) |
| `hooks.beforeToolCall` | DOCUMENTED_AND_OBSERVED | api.md + block-dangerous-commands example |
| Session start (`onSessionStart` / `session_start`) | DOCUMENTED_AND_OBSERVED | lifecycle-hooks example + api.md |
| `prepareNextTurn` → model/effort next round | DOCUMENTED_AND_OBSERVED | hooks-and-events (too late for first request; not primary path) |
| Permission-mode mutation API | UNSUPPORTED | no ModApi setter for permission mode / auto-accept / yolo |
| Automatic `--apply` from Mod | UNSUPPORTED | deliberately not exposed; Mod must not invent it |
| Hooks as primary recursion control | AMBIGUOUS / defence-in-depth only | CLI help still has zero hook flags; Mod `beforeToolCall` is documented but binary-level guard remains authoritative |

## Pre-request model selection (gate)

```text
typed user prompt
  → hooks.transformInput({text})   // before model sees input
  → cmd.setModel(id)               // live / buffered setter
  → original (or marker-stripped) prompt continues
  → model_request_start {model}    // first inference uses selected model
```

Only real typed input is intercepted. Automated turns, meta messages, image-carrying
prompts, and slash commands **never** route through `transformInput`
(DOCUMENTED_AND_OBSERVED).

**Gate result:** installed API **can** change the model before an ordinary typed prompt
is submitted. TP-001 proceeds (not BLOCKED).

## Unsupported / limited prompt surfaces

| Surface | Fallback |
| --- | --- |
| Slash commands | Explicit `/route*` commands only; no auto-route |
| Image-carrying prompts | No transformInput; CLI `ccroute decide/run` |
| Automated / meta turns | No transformInput; unchanged session model |
| Headless `-p` print mode | User-scope / `--mod` mods load; UI degraded; project mods excluded unless dangerous skip |
| Hooks-only PreToolUse | Unverified as primary; kept as optional defence-in-depth |

## Compatibility declaration (Mod package)

```text
commandCodeMin: 1.4.0
commandCodeProbed: 1.4.1
modApiSurface: ModApi (hooks.transformInput, setModel, setEffort, addCommand, on, beforeToolCall)
failMode: graceful degrade + CLI fallback
```

## Hard non-goals for the Mod

```text
The Mod may select a model.
The Mod may not enable --apply.
The Mod may not change permission mode.
The Mod may not enable auto-accept.
The Mod may not enable YOLO.
The Mod may not launch recursive ccroute orchestration.
```
