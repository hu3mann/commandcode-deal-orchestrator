# Test Report

Date: 2026-07-26

## Deterministic suite

```bash
npm run typecheck   # pass
npm run lint        # pass
npm test            # 125 passed (19 files)
npm run test:coverage  # lines 90.55% branches 85.76% (core modules; thresholds 90/85)
npm run build       # pass
npm pack            # SHA256: 3bbf3366753b561637481fc3d150acd635e80e010b223ece2eeeec6d28ec39be
```

## Isolated package install

PASS — `npm install` of `.tgz` into temp prefix; `ccroute --version`, `config validate`, `decide` all exit 0.

## CLI smoke (local)

| Command | Result |
| --- | --- |
| `ccroute doctor` | PASS — cmd 1.4.1, auth true, 48 models |
| `ccroute decide "list files"` | PASS — free/cheap model, 0 LLM |
| `ccroute deals refresh --network` | PASS — 10 known models updated |
| `ccroute config validate` | PASS |

## Live smoke

```bash
CCROUTE_LIVE=1 CCROUTE_LIVE_BUDGET=0.25 npm run test:live
# 4/4 PASS — CommandCode v1.4.1
# inclusionai/ling-3.0-flash-free ~$0.00015 est
# xai/grok-4.5 ~$0.029 est
```
