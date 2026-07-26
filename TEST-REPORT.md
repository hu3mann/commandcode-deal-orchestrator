# Test Report

Date: 2026-07-26

## Deterministic suite

```bash
npm run typecheck   # pass
npm run lint        # pass
npm test            # 112 passed (17 files)
npm run test:coverage  # lines 94.46% branches 89.11%
npm run build       # pass
npm pack            # SHA256: 21497dbd9d73bd00bafe64b0e608b82c705aeff61f4f390a669e48b961c7e69f
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
| `ccroute --version` | PASS — "0.1.0" |

## Isolated package install

PASS (prior session) — `npm install` from `.tgz` in temp directory; `ccroute --version`, `ccroute doctor`, `ccroute decide`, `ccroute config validate` all work.

## Live smoke

NOT_RUN this session (no `CCROUTE_LIVE=1` flag). Previous session passed under budget against CommandCode.
