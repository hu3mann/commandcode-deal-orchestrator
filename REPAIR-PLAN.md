# CCROUTE-001 — Repair Plan

Derived from `AUDIT-REPORT.md`. Ordered by exploitability, then by dependency.

## Principles

1. **Fix the instrument before the readings.** Coverage narrowing (`AUD-007`) is repaired in Wave 1 so that every later claim is measured honestly.
2. **No re-gaming.** Coverage `include` is never narrowed again. If the honest number lands below the §35 bar, the number is reported as-is and the gap recorded — not hidden.
3. **Every fix ships with a test that fails without it.** A test that would pass against the broken code does not count as remediation.
4. **No self-certification.** The final verdict is assigned against re-run evidence, not against intent.

## Work partitioning

Agents run in waves. Within a wave, file ownership is disjoint — no two agents may edit the same file. Ownership is exclusive and stated per unit.

### Wave 1 — parallel

| Unit | Owns | Fixes |
| --- | --- | --- |
| **R1 security-core** | `src/discovery/commandcode-cli.ts`, `src/security/{command-policy,path-policy,recursion-guard}.ts`, `src/config/{schemas,merge}.ts`, `hooks/*.mjs`, `tests/unit/{security,security-extra,hooks}.test.ts` | AUD-001, AUD-011 |
| **R2 classifier** | `src/classifier/*`, `tests/unit/classifier.test.ts` | AUD-003 |
| **R3 pricing** | `src/pricing/*`, `src/domain/{model,deal}.ts`, `tests/unit/{pricing,pricing-snapshot,official-html}.test.ts` | AUD-005, AUD-012 |
| **R4 test-hygiene** | `vitest.config.ts`, `tests/unit/branch-coverage.test.ts`, `tests/integration/decide-no-spawn.test.ts` | AUD-006, AUD-007 |

### Wave 2 — parallel, after Wave 1 lands

| Unit | Owns | Fixes |
| --- | --- | --- |
| **R5 router** | `src/router/*`, `tests/unit/{router,eligibility-extra}.test.ts` | AUD-004, AUD-009, scoring/tie-break gaps |
| **R6 orchestration** | `src/orchestration/*`, `prompts/*`, `tests/unit/orchestration.test.ts` | AUD-002, AUD-008 |
| **R8 subprocess+telemetry** | `src/subprocess/*`, `src/telemetry/*`, `tests/unit/telemetry.test.ts`, new `tests/unit/subprocess.test.ts` | AUD-010, §34.6 coverage |

### Wave 3 — after Wave 2

| Unit | Owns | Fixes |
| --- | --- | --- |
| **R7 cli** | `src/cli.ts`, new `src/cli/exit-codes.ts` | AUD-013 |
| **Integration (root)** | everything else | AUD-014, full validation, commits |

## Cross-unit contracts

Fixed interfaces so parallel units compose without coordination:

- **Error codes.** Existing typed errors (`RouteError`, `ConfigError`, `RecursionError`) keep their string `.code` property. R7 maps strings → §11 numeric exit codes centrally. No unit may remove or rename an existing `.code` value; new ones are additive.
- **Model capabilities.** R3 adds an optional `capabilities` and keeps `contextWindow` on `ModelPricing`. R5 consumes both as eligibility gates. R3 must not make either field required, to avoid breaking seed files.
- **Redaction.** R8 owns `redactText`. R6 and R7 call it before any artifact write rather than implementing their own.
- **Coverage config.** R4 owns `vitest.config.ts` exclusively. No other unit edits it, for any reason.

## Deferred by decision, not omission

Recorded here so they are visible rather than silently dropped:

- Optional direct xAI provider adapter (§33) — explicitly optional in the packet; Grok remains reachable via `cmd`.
- Full §35 90/85 coverage across all eight areas — pursued, but the honest post-un-narrowing number is reported regardless of whether it clears the bar.
- Repository signal *scanning* (§16.7) — `RepoSignals` is wired into the real call path, but the depth of repo inspection is scoped to cheap, non-secret metadata only.

## Exit criteria

The build ships only when all of the following hold, each backed by re-run output:

1. The `AUD-001` proof-of-concept no longer executes.
2. `typecheck`, `lint`, `test`, `build`, `pack`, isolated install all pass.
3. Coverage is measured over the whole of `src/`, with the resulting number stated plainly.
4. `ACCEPTANCE.json` carries a verdict justified by that evidence — not by intent.
5. Nothing is pushed or published without explicit operator authorization.
