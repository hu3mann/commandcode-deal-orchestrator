# commandcode-deal-orchestrator (`ccroute`)

Deterministic, deal-aware model router and bounded role orchestrator for [Command Code](https://commandcode.ai).

## Install

From GitHub (public):

```bash
git clone https://github.com/hu3mann/commandcode-deal-orchestrator.git
cd commandcode-deal-orchestrator
npm ci
npm run build
npm link
```

From a local checkout or tarball:

```bash
npm ci && npm run build && npm link
# or
npm pack && npm install -g ./commandcode-deal-orchestrator-0.1.0.tgz
```

Requires Node.js 20+ and Command Code CLI (`cmd`) for live runs. Never invent model IDs — use `cmd --list-models` or `ccroute models list`.

## First-run setup

```bash
ccroute doctor
ccroute config validate
ccroute deals refresh
ccroute models list
```

## Common commands

```bash
ccroute decide "Summarize this repository"
ccroute explain "Refactor authentication across three services"
ccroute run "Fix the failing unit tests"
ccroute run "Fix the failing unit tests" --apply
ccroute orchestrate "Replace the authentication middleware" --apply
ccroute stats
```

## Profiles

`--profile cheapest|balanced|frontier` (or markers `!cheap` `!balanced` `!frontier`).

## Model overrides

`--model <id>` or `!model=<id>`. Explicit models never silently fall back.

## Apply behavior

Without `--apply`, runs stay non-writing (no `--auto-accept`).  
`--unsafe-yolo` is explicit-only and prints a warning.

## Deal refresh

```bash
ccroute deals status
ccroute deals refresh
ccroute deals refresh --network   # optional official page fetch
```

Routing uses the last valid snapshot; failed refresh preserves prior data.

## Config paths

| Scope | Path |
| --- | --- |
| User | `~/.commandcode/deal-router.yaml` |
| Project | `.commandcode/deal-router.yaml` |
| State | `~/.commandcode/deal-router/` |

Precedence: CLI > project > user > defaults.

## Telemetry

`~/.commandcode/deal-router/telemetry.jsonl` (disable with `--no-telemetry`).

## Skill installation

```bash
mkdir -p ~/.commandcode/skills
cp -R skills/commandcode-deal-orchestrator ~/.commandcode/skills/
```

## Hooks

See `examples/commandcode-settings.hooks.json` and `hooks/`.

## Troubleshooting

| Issue | Check |
| --- | --- |
| `cmd not found` | Install Command Code; `ccroute doctor` |
| Explicit model unavailable | `ccroute models list` for live IDs |
| Dirty worktree blocked | `--allow-dirty` or clean tree |
| Nested orchestration blocked | Expected under `CCROUTE_CHILD=1` |

## Uninstall

```bash
npm unlink -g commandcode-deal-orchestrator
# or npm uninstall -g commandcode-deal-orchestrator
rm -rf ~/.commandcode/deal-router
```

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation spec](docs/IMPLEMENTATION-SPEC.md)
- [Traceability](docs/TRACEABILITY-MATRIX.md)
- [Security](docs/SECURITY.md)
- [Capability baseline](docs/COMMANDCODE-CAPABILITY-BASELINE.md)

## License

MIT
