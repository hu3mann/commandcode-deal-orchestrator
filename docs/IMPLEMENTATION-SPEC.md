# Implementation Spec — ccroute

Observable behavior contracts. Prefer tables and schemas.

## CLI

| Command | Behavior |
| --- | --- |
| `ccroute doctor [--json]` | Probe node, cmd, auth, models, config, snapshot ages, write policy |
| `ccroute models list\|refresh` | Live IDs from `cmd --list-models`; never invent IDs |
| `ccroute deals list\|status\|refresh` | Snapshot ops; refresh failure preserves prior |
| `ccroute decide <task>` | Route only; **zero** model calls |
| `ccroute explain <task>` | Full deterministic explanation |
| `ccroute run <task> [--apply]` | Single `cmd --print --model` |
| `ccroute orchestrate <task> [--apply]` | Multi-role when justified |
| `ccroute stats` | Telemetry aggregates |
| `ccroute config show\|validate\|paths` | Config inspection |

### Flags

| Flag | Effect |
| --- | --- |
| `--profile cheapest\|balanced\|frontier` | Scoring profile |
| `--model <id>` | Explicit model; **no silent fallback** if unavailable |
| `--no-free` | Exclude free deals |
| `--max-estimated-cost` | Fail if all candidates exceed |
| `--apply` | Allows `--auto-accept` on executor |
| `--unsafe-yolo` | Warning + `--yolo`; never from config default |
| `--allow-dirty` | Permit dirty worktree with orchestrate `--apply` |
| `--no-telemetry` | Skip JSONL append |

### Markers (stripped before model)

`!cheap` `!balanced` `!frontier` `!no-free` `!model=<id>` — CLI flags win.

## Config precedence

```text
CLI flags > project .commandcode/deal-router.yaml > user ~/.commandcode/deal-router.yaml > built-in defaults
```

Malformed project config → fail closed. Unknown security-sensitive keys rejected.

## Pricing

```text
cost = fresh_in + cache_read + output + cache_write
```

- Normalize per-million rates.
- If `priceBasis: post_discount`, **do not** multiply deal factors again.
- Expired free deals excluded.
- Temporary rates roll to `replacementRate` after expiry; missing replacement → ineligible.

## Task classes

`read_only` | `trivial_edit` | `standard_build` | `complex_build` | `architecture` | `high_risk_review`

High-risk signals never downgraded solely due to short prompts.

## Routing

```text
expected_total_cost = request + retry + escalation + latency_penalty
```

Tie-break: lower cost → higher success → lower latency → lexical id.

Profiles use configurable weights only (see `config/routing.default.yaml`).

## Role envelope

```text
BEGIN_CCROUTE_RESULT
{ "schemaVersion": 1, "role": "...", "status": "success", "summary": "...", "artifacts": [], "findings": [], "nextAction": "..." }
END_CCROUTE_RESULT
```

One format repair; second failure fail-closed. Role output is untrusted data.

## Subprocess

- `child_process.spawn(cmd, argv, { shell: false })`
- Task on **stdin**, not argv
- Timeouts, bounded stdout/stderr, exit propagation

## Error codes (selected)

| Code | Meaning |
| --- | --- |
| `CONFIG_INVALID` | Bad YAML/schema |
| `EXPLICIT_MODEL_UNAVAILABLE` | Required model missing |
| `NO_ELIGIBLE_MODEL` | Floor/deal filters empty set |
| `MAX_COST_EXCEEDED` | Budget |
| `RECURSION_BLOCKED` | Nested ccroute |
| `DIRTY_WORKTREE` | Orchestrate apply without allow |

## Acceptance tests (core)

| Requirement | Verification |
| --- | --- |
| `decide` no model call | fake cmd invocation count = 0 |
| expired free excluded | fixture |
| explicit unavailable no fallback | nonzero exit |
| `--apply` required for writes | child argv lacks `--auto-accept` without apply |
| no shell injection | fixed argv array |
| no double discount | numeric unit |
| recursion blocked | `CCROUTE_DEPTH=2` / `CCROUTE_CHILD=1` |

## Coverage gates

90% line / 85% branch on routing, pricing, configuration, security modules.
