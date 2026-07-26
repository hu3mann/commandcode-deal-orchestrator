# Architecture — commandcode-deal-orchestrator (`ccroute`)

## Purpose

Deterministic local control plane that selects the cheapest *eligible* CommandCode model for a task and optionally runs bounded multi-role orchestration. No LLM is used for classification or routing.

## System diagram

```text
CLI / Skill
    |
    v
Configuration + Discovery
    |
    v
Deterministic Classifier
    |
    v
Eligibility + Cost Scorer
    |
    +------------------+
    |                  |
    v                  v
Single-model run   Role Orchestrator
                       |
          +------------+------------+
          |            |            |
       Planner       Executor     Reviewer
          |            |            |
          +---- CommandCode Adapter-+
                    (spawn shell:false)
```

## Components

| Component | Responsibility |
| --- | --- |
| `cli` | Commander entry; fail-closed exits |
| `config` | Defaults + user/project YAML merge + Zod |
| `discovery` | `cmd` path, version, status, `--list-models` |
| `pricing` | Snapshots, calculator, refresh (no double discount) |
| `classifier` | Deterministic task class + markers |
| `router` | Eligibility, scoring, select, explain |
| `subprocess` | Safe `spawn`, stdin packets, timeouts |
| `orchestration` | Planner/Advisor/Executor/Reviewer lifecycle |
| `telemetry` | Append-only JSONL + aggregates |
| `security` | Recursion, model-id safety, path policy |

## Dependency rules

```text
pricing must not import subprocess
classifier must not import telemetry
router may consume pricing and telemetry aggregates
orchestrator may consume router and subprocess adapters
domain types must remain dependency-free
optional xai-direct (future) isolated from CommandCode backend
```

## Control invariants

1. **ccroute is the root dispatcher** — never a child LLM.
2. **CommandCode only via subprocess adapter** — fixed argv, `shell: false`.
3. **Deterministic classification** — signal dictionaries + repo metadata (no secrets).
4. **Pricing snapshots ≠ routing policy** — rates in snapshot; floors/weights in config.
5. **Roles are bounded child processes** — env `CCROUTE_CHILD`, depth guard.
6. **No shell interpolation** of task text or model ids.
7. **Explicit write authorization** — `--apply` required before `--auto-accept`.
8. **Telemetry redaction** — no keys/tokens/source bodies by default.
9. **Fail-closed** — bad config, unknown model, expired deal, recursion, dirty worktree with `--apply` (run or orchestrate).
10. **Recursion prevention** — `CCROUTE_DEPTH > 1` and child re-entry rejected.

## Role workflow

```text
classify → route → [planner?] → [advisor? independent model] → executor → [reviewer?] → manifest
```

Orchestration is skipped for `read_only` / `trivial_edit` unless `--force`.

## Data stores

| Path | Content |
| --- | --- |
| `~/.commandcode/deal-router.yaml` | User config |
| `.commandcode/deal-router.yaml` | Project config |
| `~/.commandcode/deal-router/pricing-snapshot.json` | Pricing |
| `~/.commandcode/deal-router/deals-snapshot.json` | Deals |
| `~/.commandcode/deal-router/telemetry.jsonl` | Telemetry |
| `.commandcode/deal-router/runs/<id>/` | Per-run artifacts |

## Non-goals

Daemon, hosted service, LLM classifier, automatic billing, arbitrary provider URLs, required xAI backend.
