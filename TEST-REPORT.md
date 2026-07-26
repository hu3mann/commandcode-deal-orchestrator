# Test Report

Date: 2026-07-26
Commit: post-audit remediation, branch `fix/CCROUTE-001-audit-remediation`

## Deterministic suite

```bash
npm run typecheck      # pass
npm run lint           # pass (75 files, Biome)
npm test               # 408 passed (28 files), 0 failed, 0 skipped
npm run test:coverage  # lines 91.55%  branches 86.95%  (thresholds 90 / 85)
npm run build          # pass
npm pack               # commandcode-deal-orchestrator-0.1.0.tgz
```

No paid model call occurs during `npm test` or `npm run test:coverage`. All subprocess
tests use fake executables created in temporary directories.

## Coverage

Measured over **all of `src/`**. The pre-audit configuration restricted measurement to
five directories, excluding 1,892 of 3,822 lines (49.5%) — including two of the eight
areas §35 names by name. That narrowing has been removed and not reintroduced.

| §35 area | Lines | Branches | Bar (90/85) |
| --- | --- | --- | --- |
| configuration | 93.77% | 85.26% | pass |
| pricing | 92.33% | 86.36% | pass |
| classifier | 96.39% | 94.02% | pass |
| eligibility | 98.24% | 97.56% | pass |
| scoring (`scorer.ts`) | 100% | 100% | pass |
| subprocess | 97.97% | 92.68% | pass |
| recursion guard | 100% | 100% | pass |
| secret redaction | 100% | 100% | pass |

Whole-tree totals: **91.55% lines, 86.95% branches**, both above threshold.

Areas below 90% lines that §35 does not name, recorded rather than hidden:
`src/orchestration` 83.95%, `src/cli.ts` 86.55%, `src/discovery` 91.01% lines with
72.04% branches.

## Coverage history

| Stage | Lines | Branches | Scope |
| --- | --- | --- | --- |
| Pre-audit (as claimed) | 90.55% | 85.76% | 5 of 12 `src/` directories |
| Instrument corrected | 59.03% | 79.53% | all of `src/` |
| After wave 2 | 76.73% | 84.47% | all of `src/` |
| Final | **91.55%** | **86.95%** | all of `src/` |

The drop at stage two is the honest baseline being revealed, not a regression.

## Mutation checks

Two controls were verified load-bearing by deliberately removing them, confirming the
suite goes red, then restoring:

| Control | Behaviour without it |
| --- | --- |
| Double-discount guard (`pricing/calculator.ts`) | `expected 0.125 to be close to 0.5` — the rate is double-discounted |
| Validation-gate authority (`orchestration/orchestrator.ts`) | `expected +0 to be 6` — a Reviewer ACCEPT passes a failing run |

This matters because the pre-audit double-discount test passed whether or not any guard
existed — there was no multiplication code for a guard to protect.

## Isolated package install

PASS. `npm pack`, then `npm install` of the tarball into a temporary prefix outside the
repository. All eight verification commands exit 0:

`--help` · `--version` · `doctor` · `config validate` · `models list` · `deals status` ·
`decide` · `explain`

Captured in `evidence/validation/isolated-install.txt`.

## Exploit regression

The audit's proof-of-concept for AUD-001 (arbitrary code execution via project-scope
`cmdPath`) was re-run against the patched build. Both the absolute-path and
relative-path variants now fail closed with `CONFIG_INVALID`, and no marker file is
created.

## Live smoke

**NOT RUN.**

Live testing is opt-in (`CCROUTE_LIVE=1`) and was not performed during remediation. The
pre-audit report claimed a 4/4 live PASS, but no evidence artifact for it exists
anywhere in the repository, so that claim is not carried forward.

One unintended live call did occur: an audit subagent operating under a read-only
instruction executed `ccroute run "trivial task" --unsafe-yolo`, producing a single
free-tier call on `inclusionai/ling-3.0-flash-free` at an estimated $0.00015. That is
disclosed, not counted as a live test.

Because live CommandCode invocation is unverified, the acceptance verdict is
`PASS_WITH_LIMITATIONS`, per §36.
