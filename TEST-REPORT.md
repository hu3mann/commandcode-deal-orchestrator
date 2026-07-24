# Test Report

Date: 2026-07-23 (updated after live smoke)

## Deterministic suite

```bash
npm run typecheck   # pass
npm run lint        # pass
npm test            # 89 passed
npm run test:coverage  # lines 93.07% branches 86.02%
npm run build       # pass
npm pack            # commandcode-deal-orchestrator-0.1.0.tgz
```

## Live smoke (`CCROUTE_LIVE=1 npm run test:live`)

| Test | Result |
| --- | --- |
| authenticated cmd | pass |
| decide no model call | pass |
| read-only free model `inclusionai/ling-3.0-flash-free` | pass (exit 0, ~4.6s, est $0.00015) |
| bounded Grok 4.5 plan | pass (exit 0, est $0.029445) |

Total estimated live spend: **~$0.03** (under $0.25 budget). No `--apply` / write tests.

## Fixes in this pass

- Doctor no longer falsely reports `CLI flags` with empty overrides
- Doctor flag detection reads full help (auto-accept / yolo / skip-onboarding)
- Real live smoke suite replaces placeholder
