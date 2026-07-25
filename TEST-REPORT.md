# Test Report

Date: 2026-07-25

## Deterministic suite

```bash
npm run typecheck   # pass
npm run lint        # pass
npm test            # 91 passed (17 files)
npm run test:coverage  # lines 92.7% branches 86.31%
npm run build       # pass
npm pack            # SHA256: 2eea387547347b31cd22f5acb6cdda1bf4ab701cc67ced459403472e1af517f7
```

## CLI commands verified

| Command | Result |
| --- | --- |
| `ccroute doctor` | PASS — node, cmd path, version, auth, 48 models |
| `ccroute doctor --json` | PASS — structured JSON output |
| `ccroute config validate` | PASS — merged config OK |
| `ccroute decide "test task"` | PASS — deterministic, 0 LLM calls |
| `ccroute explain "test task"` | PASS — full explanation output |
| `ccroute runs list` | PASS — "(no runs)" correct output |
| `ccroute --version` | PASS — "0.1.0" |

## Isolated package install

PASS — `npm install` from `.tgz` in temp directory; `ccroute --version`, `ccroute doctor`, `ccroute decide`, `ccroute config validate` all work.

## Live smoke

NOT_RUN this session (no `CCROUTE_LIVE=1` flag). Previous session passed with CommandCode v1.3.1 under $0.03 budget.
