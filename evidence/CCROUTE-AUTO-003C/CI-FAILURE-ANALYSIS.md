# CI Failure Analysis — TP-CCROUTE-AUTO-003C

## Historical CI (pre-merge)

### PR #3 run 30227260445 @ 39b55d2
- Command: `npm run test:coverage`
- Node 20: lines 91.4%, **branches 84.79%** (threshold 85%) → FAIL
- Node 22: lines 91.4%, **branches 84.8%** → FAIL
- typecheck/lint/tests pass; downstream jobs skipped

### PR #4 run 30227640186 @ 810d681
- Command: `npm run test:coverage`
- Node 20/22: **lines 87.3%**, **statements 87.3%**, **branches 83.73%** → FAIL
- Cause: new `src/refresh/**` surface without matching branch/line tests

## Local vs CI
Local TP-002 claimed 85.03% branches; CI measured ~84.8%. Margin was eyelash-thin (~0.2pp), so Linux CI correctly failed.

## Incorrect subsequent "repair" (already on main)
Commit `db2affa` lowered branches threshold **85 → 84**, then merged via PR #3/#4.
That violated the coverage contract. 003C restores 85 and adds real tests.

## Repair
- Restore thresholds 90/85/85/90, include `src/**/*.ts`
- Add `tests/unit/coverage-branch-repair.test.ts` (install+refresh custody contracts)
- Remove dead lease dual-path; document multi-process TOCTOU with v8 ignore start/stop
- Best-effort catch ignores only for non-contractable cleanup failures
