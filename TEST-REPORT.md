# Test Report

Date: 2026-07-26

## Deterministic suite

```bash
npm run typecheck   # pass
npm run lint        # pass
npm test            # 125 passed (19 files)
npm run test:coverage  # lines 94.46%+ branches 89.11%+ (core modules)
npm run build       # pass
```

## CLI commands verified

| Command | Result |
| --- | --- |
| `ccroute doctor` | PASS — node, cmd path, version, auth, live models |
| `ccroute doctor --json` | PASS — structured JSON output |
| `ccroute config validate` | PASS — merged config OK |
| `ccroute decide "test task"` | PASS — deterministic, 0 LLM calls |
| `ccroute explain "test task"` | PASS — full explanation output |
| `ccroute runs list` | PASS — empty or listed runs |
| `ccroute deals refresh --network` | PASS — 10 known models updated from official HTML |
| `ccroute --version` | PASS — "0.1.0" |

## Isolated package install

PASS (prior session) — `npm install` from `.tgz` in temp directory; `ccroute --version`, `ccroute doctor`, `ccroute decide`, `ccroute config validate` all work.

## Live smoke

```bash
CCROUTE_LIVE=1 CCROUTE_LIVE_BUDGET=0.25 npm run test:live
# 4/4 PASS against CommandCode v1.4.1
# free: inclusionai/ling-3.0-flash-free (~$0.00015 est, exit 0)
# frontier: xai/grok-4.5 (~$0.029 est, exit 0)
```
