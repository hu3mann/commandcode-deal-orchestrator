---
name: commandcode-deal-orchestrator
description: Route tasks to the cheapest safe CommandCode model using current deals; decide, explain, run, or orchestrate via the external ccroute dispatcher. Use when the user asks to route cheaply, pick the cheapest safe model, orchestrate with planner/executor, or use CommandCode deals.
---

# CommandCode Deal Orchestrator

External dispatcher owns model selection. Skills do not change the active session model by themselves.

## Preconditions

1. Check `ccroute` is installed (`command -v ccroute` or `npx ccroute`).
2. If missing, tell the user to install `commandcode-deal-orchestrator`.
3. If `CCROUTE_CHILD=1`, refuse nested invocation.

## Workflows

### Explain / decide (no paid call required for decide)

```bash
ccroute decide "TASK"
ccroute explain "TASK"
```

### Single-model run

1. Run `ccroute decide "TASK"` and show the selected route to the user.
2. Only then run:

```bash
ccroute run "TASK"
```

Never add `--apply` unless the user explicitly asked to apply/write.

Never add `--unsafe-yolo` unless the user explicitly requested it.

### Orchestration

Use only for complex multi-file / architecture / high-risk work:

```bash
ccroute orchestrate "TASK"
ccroute orchestrate "TASK" --apply   # only if user authorized writes
```

## Activation phrases

- route this cheaply
- pick the cheapest safe model
- orchestrate this task
- use the current CommandCode deals
- run this with planner and executor
- explain which model is cheapest

## Safety

- Display selected route before paid execution.
- No silent `--apply`.
- No silent `--unsafe-yolo`.
- Refuse when already inside a bounded child session.
