# Changelog

## 0.1.0 (2026-07-25)

Initial MVP release.

### Features

- **`ccroute doctor`** — system health with JSON output, flag detection from live `cmd`
- **`ccroute models list/refresh`** — live model inventory from `cmd --list-models`; never invents IDs
- **`ccroute deals list/status/refresh`** — deal snapshot ops; refresh preserves prior snapshot on failure
- **`ccroute decide <task>`** — deterministic route decision; **zero** LLM calls
- **`ccroute explain <task>`** — full deterministic route explanation with scoring breakdown
- **`ccroute run <task>`** — single-model `cmd` subprocess execution; read-only by default; `--apply` for write mode
- **`ccroute orchestrate <task>`** — bounded Planner/Advisor/Executor/Reviewer workflow for complex tasks
- **`ccroute stats`** — telemetry aggregate display
- **`ccroute config show/validate/paths`** — configuration inspection
- **Routing** — deterministic classifier (6 task classes), 3 profiles (cheapest/balanced/frontier), reliability-adjusted scoring
- **Pricing** — official-source refresh, atomic snapshot persistence, post-discount protection against double promotion
- **Security** — shell:false subprocess, model-ID validation, recursion guard (CCROUTE_CHILD/CCROUTE_DEPTH), path policy, secret redaction, dirty-worktree gate for orchestrated apply
- **Telemetry** — append-only JSONL, model aggregates, redaction, `--no-telemetry` flag
- **Hooks** — `child-recursion-guard.mjs`, `child-session-context.mjs`
- **Skill** — `skills/commandcode-deal-orchestrator/SKILL.md`

### Quality

- ~2,600 lines TypeScript (ESM)
- 17 test files, 91 tests
- 93% line coverage, 86% branch coverage on core modules
- typecheck, lint (Biome), build all clean
- Live smoke tested against CommandCode v1.4.1 under budget
