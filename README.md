# commandcode-deal-orchestrator (`ccroute`)

Deterministic, deal-aware model router and bounded role orchestrator for [Command Code](https://commandcode.ai).

## Architecture at a glance

`ccroute` is a local CLI, not a service. The routing decision is deterministic and
**never requires an LLM call**:

```text
CLI parser
  → config (defaults < user < project < flags)
  → deterministic classifier (task + repository signals)
  → eligibility filter (live catalog, context, capabilities, quality floor, pricing)
  → reliability-adjusted scorer (cost + retry + escalation + latency)
  → cmd subprocess adapter (spawn, shell:false, task on stdin)
```

Orchestration adds bounded Planner → Advisor → Executor → **deterministic validation**
→ Reviewer → one repair. Deterministic validation runs your real local commands and is
authoritative: a Reviewer `ACCEPT` cannot pass a run whose tests failed.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component boundaries and
dependency rules.

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

## Explain output

`ccroute explain "task"` shows the full derivation of a route — task class, detected
signals, repository signals, risk level, required capabilities, candidates, every rejected
model with its reason, cost components, scoring coefficients, tie-break rule and
snapshot age.

```bash
ccroute explain "Refactor authentication across three services"
ccroute explain "..." --json    # machine-readable, same fields
```

Costs are labelled `estimate`. They are derived from token priors and the current
pricing snapshot — they are **not** observed usage. Treat them as a basis for
comparison between models, not as a billing prediction.

## Deal expiry

Deals carry `startsAt` / `expiresAt` and are evaluated against real timezone-aware
instants, not local date strings. A deal that has not started is recorded but not
applied; an expired deal is excluded from the instant it expires.

Snapshot freshness is enforced, not merely reported: fresh (<24h), acceptable
(24–72h), stale (>72h), all configurable. A **stale snapshot cannot be used for a
model whose price depends on a deal or a temporary rate** — that model becomes
ineligible until a refresh succeeds. Stale base rates on deal-free models remain
usable and the staleness is reported in the decision.

`ccroute deals status` lists expired deals; `ccroute doctor` surfaces them as warnings.

## Deal refresh

```bash
ccroute deals status
ccroute deals refresh             # re-seed from bundled official rates
ccroute deals refresh --network   # fetch+parse official pricing-limits page
```

`--network` merges rates/deals into **known** snapshot model IDs only (never
invents IDs). Failed fetch/parse preserves the last valid snapshot.

## Commit behavior

`--commit` requires `--apply` and commits **only** files the run created or modified.
It records the resulting commit hash in the run manifest.

It never pushes, never force-pushes, never rewrites history, never stages unrelated
files, and never deletes untracked files. Pushing is always yours to do.

```bash
ccroute run "..." --apply --commit
```

Apply mode also requires a clean worktree unless you pass `--allow-dirty`. Read-only
runs are unaffected by worktree state.

## Config paths

| Scope | Path |
| --- | --- |
| User | `~/.commandcode/deal-router.yaml` |
| Project | `.commandcode/deal-router.yaml` |
| State | `~/.commandcode/deal-router/` |

Precedence: CLI > project > user > defaults.

## Telemetry

`~/.commandcode/deal-router/telemetry.jsonl` (disable with `--no-telemetry`).

## Privacy

What leaves your machine: only the task text and bounded context you route, sent to
CommandCode by the `cmd` binary you already have installed. `ccroute` adds no
telemetry endpoint, no analytics, and no network calls of its own except the opt-in
`deals refresh --network` fetch of the official public pricing page.

What is written to disk, locally only:

| Path | Contents |
| --- | --- |
| `~/.commandcode/deal-router/telemetry.jsonl` | Task **hash**, class, model, latency, cost estimate — never task text or source code |
| `.commandcode/deal-router/runs/<run-id>/` | Run manifest, decision, role results, redacted role output |

Secret redaction runs before anything is persisted, covering common API-key, token,
Authorization-header, cookie and private-key formats. Redaction is a **secondary**
defence — the primary one is not collecting the data. It is pattern-based and cannot
catch encoded, split, or unknown-format secrets; do not rely on it alone.

Disable telemetry entirely with `--no-telemetry`, or `telemetry.enabled: false` in
config.

## Skill installation

```bash
mkdir -p ~/.commandcode/skills
cp -R skills/commandcode-deal-orchestrator ~/.commandcode/skills/
```

## Hooks (operator install)

Child sessions still have a normal Command Code tool surface. Install the
shipped hooks so nested `ccroute` is denied under `CCROUTE_CHILD=1`:

```bash
# Merge examples/commandcode-settings.hooks.json → .commandcode/settings.json
# (or use absolute node paths if hooks live only in the global package)
ls hooks/*.mjs
echo '{}' | CCROUTE_CHILD=1 node ./hooks/child-recursion-guard.mjs
```

Full steps, verify commands, and threat notes: [docs/OPERATIONS.md](docs/OPERATIONS.md#operator-hooks-recommended).

## Troubleshooting

| Issue | Check |
| --- | --- |
| `cmd not found` | Install Command Code; `ccroute doctor` |
| Explicit model unavailable | `ccroute models list` for live IDs |
| Dirty worktree blocked on `--apply` | `--allow-dirty` or clean tree |
| Nested orchestration blocked | Expected under `CCROUTE_CHILD=1` |

## Uninstall

```bash
npm unlink -g commandcode-deal-orchestrator
# or npm uninstall -g commandcode-deal-orchestrator
rm -rf ~/.commandcode/deal-router
```

## Optional xAI configuration

Not implemented in v0.1.0. The packet specifies a direct xAI provider adapter as
**optional**, gated behind explicit provider enablement, reading `XAI_API_KEY` only at
runtime, never persisting or printing it, never passing it in argv, and refusing
arbitrary base URLs.

Until it exists, Grok is reachable the same way every other model is — through `cmd`,
selected by the router:

```bash
ccroute run "..." --model xai/grok-4.5
```

## Limitations

Known and deliberate, as of v0.1.0:

- **Capability-based eligibility is inert.** The gate is implemented and tested, but no
  model catalog supplies capability data, so it currently matches nothing. Populating
  it with invented values would break the "never invent model facts" rule.
- **The recursion guard is bypassable.** It is environment-variable based, so a child
  that strips its own environment defeats it. The hook layer meant to back it up is
  unverified against the installed CLI — `cmd --help` does not document hooks.
- **Costs are estimates.** Observed usage is recorded only when the provider returns
  it mechanically; casual model prose is never parsed as usage evidence.
- **Network deal refresh covers known model IDs only.** Models present on the pricing
  page but absent from the snapshot are ignored rather than invented.
- **No direct xAI provider adapter.** Grok remains reachable through `cmd`.
- **Orchestration is not parallel.** One Executor, bounded revisions and repairs.

See [AUDIT-REPORT.md](AUDIT-REPORT.md) for the independent audit that produced this
list and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for accepted residual risks.

## Docs

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation spec](docs/IMPLEMENTATION-SPEC.md)
- [Traceability](docs/TRACEABILITY-MATRIX.md)
- [Security](docs/SECURITY.md)
- [Capability baseline](docs/COMMANDCODE-CAPABILITY-BASELINE.md)

## License

MIT
