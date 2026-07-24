# Test Report

Date: 2026-07-23

## Commands

```bash
npm run typecheck   # pass
npm run lint        # pass
npm test            # 87 passed
npm run test:coverage  # lines 93.07% branches 86.02% (gated modules)
npm run build       # pass
npm pack            # commandcode-deal-orchestrator-0.1.0.tgz
```

## Suites

| Suite | Result |
| --- | --- |
| unit/classifier | pass |
| unit/config + loader | pass |
| unit/pricing + snapshot | pass |
| unit/router + eligibility | pass |
| unit/security | pass |
| unit/orchestration | pass |
| unit/hooks | pass |
| unit/telemetry | pass |
| integration/decide-no-spawn | pass |
| integration/apply-argv | pass |
| live smoke | skipped (opt-in) |

## Install smoke

Isolated `npm install -g --prefix <tmp>` of packed tarball:

- `ccroute --help` ok
- `ccroute doctor` ok (cmd 1.3.1, authenticated)
- `ccroute decide --no-free` → `deepseek/deepseek-v4-flash`
- `ccroute explain` produces full breakdown

## Coverage (routing/pricing/config/security/classifier)

- Lines: **93.07%** (threshold 90%)
- Branches: **86.02%** (threshold 85%)
- Functions: **100%**
