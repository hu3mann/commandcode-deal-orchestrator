# Operations

## Install

```bash
npm pack
npm install -g ./commandcode-deal-orchestrator-0.1.0.tgz
```

Or from source:

```bash
npm ci
npm run build
npm link
```

## First run

```bash
ccroute doctor
ccroute config validate
ccroute models list
ccroute deals status
ccroute decide "Summarize this repository"
ccroute explain "Refactor authentication across three services"
```

## Config paths

- User: `~/.commandcode/deal-router.yaml`
- Project: `.commandcode/deal-router.yaml`
- State: `~/.commandcode/deal-router/`

## Telemetry

Append-only JSONL at `~/.commandcode/deal-router/telemetry.jsonl`. Disable with `--no-telemetry`.

## Skill

Copy or link `skills/commandcode-deal-orchestrator` into `~/.commandcode/skills/` or project `.commandcode/skills/`.

## Hooks example

See `examples/commandcode-settings.hooks.json`.
