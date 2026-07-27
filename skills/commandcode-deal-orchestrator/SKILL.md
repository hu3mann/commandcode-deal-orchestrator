---
name: commandcode-deal-orchestrator
description: Route tasks with deterministic ccroute (Mod automatic routing where supported, explicit decide/run/orchestrate otherwise). Use for cheapest-safe model selection, deals, install/status, and explicit write boundaries.
---

# CommandCode Deal Orchestrator

Deterministic **ccroute** owns model selection. Skills do not invent model IDs.

## Prompt surfaces

```text
ordinary typed interactive prompt:
    automatic Mod routing where supported (transformInput)

slash command, image prompt, automated turn, or headless:
    explicit /route, /orchestrate, ccroute run, or ccroute orchestrate

writes:
    always require explicit user authorization (--apply only when user asks)
```

Do **not** claim zero-friction routing for surfaces the Mod cannot intercept.

## Preconditions

1. Prefer installed `ccroute` (`command -v ccroute`).
2. If missing: `npm ci && npm run build && npm link` then `ccroute install --project`.
3. If `CCROUTE_CHILD=1`, refuse nested invocation.
4. Run `ccroute install status` / `ccroute doctor` when setup is unclear.

## Workflows

### Explain / decide (no model spend for decide)

```bash
ccroute decide "TASK"
ccroute explain "TASK"
```

Use these for explanations. Do not tell the root model to invent route IDs.
Do **not** use a cheap-router-agent detour to pick models.

### Single-model run

1. `ccroute decide "TASK"` and show the selected route.
2. Only then:

```bash
ccroute run "TASK"
```

Never add `--apply` unless the user explicitly asked to apply/write.
Never add `--unsafe-yolo` unless the user explicitly requested it.

### Orchestration

For complex multi-file / architecture / high-risk work:

```bash
ccroute orchestrate "TASK"
ccroute orchestrate "TASK" --apply   # only if user authorized writes
```

### Install / lifecycle

```bash
ccroute install --project
ccroute install --project --skill --hooks
ccroute install --project --install-memory   # optional AGENTS.md block only
ccroute install status
ccroute install update
ccroute install repair
ccroute uninstall --project
ccroute uninstall --project --remove-memory
```

### Agents (bounded, optional)

```bash
ccroute agents list
ccroute agents refresh              # project: model inherit
ccroute agents refresh --user --pin-model <exact-live-id>
```

Agents are read-only helpers (`ccroute-planner`, `ccroute-reviewer`, `ccroute-explorer`).
They are **not** the routing mechanism.

### Refresh / catalog

```bash
ccroute refresh status
ccroute deals reconcile-live-catalog
ccroute models status
```

Stale or invalid promotions are excluded automatically when eligibility runs.
Reconciliation never invents rates for unmapped live IDs.

## Safety

- Display selected route before paid execution.
- No silent `--apply` / auto-accept / YOLO.
- Refuse nested `ccroute` in child sessions (primary recursion guard + hooks defence-in-depth).
- Settings ownership: only managed entries are updated/removed.
- Headless: use explicit `ccroute` / `--mod` paths — do not use YOLO to force project Mod load.

## Activation phrases

- route this cheaply
- pick the cheapest safe model
- orchestrate this task
- use current CommandCode deals
- install / status / uninstall ccroute
- refresh pricing or reconcile live catalog
