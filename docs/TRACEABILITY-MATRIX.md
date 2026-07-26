# Traceability Matrix

> **Accuracy note (2026-07-26).** Before the independent audit
> (`AUDIT-REPORT.md`) this matrix recorded 44 of 45 requirements as `DONE`. That
> status column was derived from intent, not from verification: several rows marked
> `DONE` covered controls that were absent, inert, or contradicted by a working
> exploit — most seriously the executable-path requirement, which was reachable as an
> arbitrary-code-execution path through `ccroute decide`.
>
> `DONE` below now means **implemented and covered by a test that fails without the
> implementation**. Requirements that are implemented but cannot yet be exercised
> against real data are marked `INERT`, and requirements whose verification depends on
> an unverified external contract are marked `UNVERIFIED`. Those three states are not
> interchangeable, and the distinction is the point.
>
> | State | Meaning |
> | --- | --- |
> | `DONE` | Implemented and verified by a failing-without-it test |
> | `INERT` | Implemented and unit-tested, but matches nothing against real data (capability eligibility) |
> | `UNVERIFIED` | Implemented, but its external contract is unconfirmed (hook-dependent controls) |
> | `DEFERRED` | Explicitly out of MVP scope (optional xAI adapter) |

| REQ-ID | Source | Architecture | Implementation | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| REQ-PROJECT-ID | §1 | package root | package.json | pack install | DONE |
| REQ-TS-STACK | §1 | toolchain | tsconfig, vitest, zod, commander | typecheck/lint/test | DONE |
| REQ-MISSION-DETERMINISTIC | §2 | classifier+router | classifier/, router/ | unit classify+decide | DONE |
| REQ-SINGLE-RUN | §2.1 | subprocess | cli run + commandcode.ts | integration fake cmd | DONE |
| REQ-ROLE-ORCH | §2.2 | orchestrator | orchestration/ | unit parser + orch mock | DONE |
| REQ-NO-CODEX-DEP | §3 | adapters only | no codex imports | grep/build | DONE |
| REQ-CC-DISCOVERY | §4 | discovery | capability baseline + doctor | doctor command; baseline re-probed against cmd v1.4.1 | DONE |
| REQ-VERIFIED-FLAGS | §5 | subprocess | command-policy.ts | unit argv | DONE |
| REQ-APPLY-EXPLICIT | §5/7.6 | security | buildCmdArgv + run | unit+integration | DONE |
| REQ-NO-YOLO-DEFAULT | §5 | security | warnUnsafeYolo | unit | DONE |
| REQ-STRUCTURE | §6 | layout | src/** | exists | DONE |
| REQ-CLI-DOCTOR | §7.1 | cli | cli.ts doctor | manual/integration | DONE |
| REQ-CLI-MODELS | §7.2 | discovery | models list/refresh | unit parse list | DONE |
| REQ-CLI-DEALS | §7.3 | pricing | deals * | unit snapshot | DONE |
| REQ-DECIDE-NO-LLM | §7.4 | router | decide | integration count=0 | DONE |
| REQ-EXPLAIN | §7.5 | router | explain.ts | unit | DONE |
| REQ-ORCH-FLAGS | §7.7 | cli | orchestrate options | cli wiring | DONE |
| REQ-TELEMETRY-CMD | §7.8 | telemetry | stats | unit aggregate | DONE |
| REQ-CONFIG-CMD | §7.9 | config | config * | unit loader | DONE |
| REQ-RUNS-CMD | §10.11 | cli | cli.ts runs list/show | manual verify | DONE |
| REQ-CONFIG-PREC | §8 | config | loader/merge | unit | DONE |
| REQ-SEED-PRICING | §9 | pricing | models.seed.json | unit calc | DONE |
| REQ-LIVE-MODEL-IDS | §9 | discovery | corrected IDs | baseline | DONE |
| REQ-CLASSIFY | §10 | classifier | deterministic.ts | unit | DONE |
| REQ-QUALITY-TIERS | §11 | config+router | eligibility | unit | DONE |
| REQ-COST-CALC | §12 | pricing | calculator.ts | unit no double disc | DONE |
| REQ-RELIABILITY | §13 | router+telemetry | scorer+aggregate | unit | DONE |
| REQ-PROFILES | §14 | router | select.ts | unit | DONE |
| REQ-DEFAULT-PREFS | §15 | config | routing.default.yaml | unit | DONE |
| REQ-ORCH-FLOW | §16 | orchestrator | orchestrator.ts | unit mock | DONE |
| REQ-ENVELOPE | §17 | orchestration | result-parser.ts | unit | DONE |
| REQ-SPAWN-SAFE | §18 | subprocess | commandcode.ts | unit policy | DONE |
| REQ-RECURSION | §19 | security | recursion-guard.ts | unit | DONE |
| REQ-GIT-SAFE | §20 | cli | ensureGitSafety | unit/integration | DONE |
| REQ-TELEMETRY-STORE | §21 | telemetry | store.ts | unit | DONE |
| REQ-ELIGIBILITY-CONTEXT | §17 | router | router/eligibility.ts | unit: oversized request rejected | DONE |
| REQ-ELIGIBILITY-CAPABILITY | §17 | router | router/eligibility.ts | unit: declared-capability mismatch rejected | INERT — no catalog supplies capability data; populating it would violate §13 |
| REQ-RECURSION-HOOK | §26 | hooks | hooks/child-recursion-guard.mjs | fixture tests only | UNVERIFIED — cmd v1.4.1 --help documents no hooks; contract assumed |
| REQ-VALIDATION-GATE | §24.5 | orchestration | orchestration/validation-gate.ts | mutation-tested: Reviewer ACCEPT cannot pass a failing run | DONE |
| REQ-EXIT-CODES | §11 | cli | src/cli/exit-codes.ts | unit + integration per code | DONE |
| REQ-NO-DOUBLE-DISCOUNT | §14 | pricing | pricing/calculator.ts | mutation-tested: removing the guard turns the test red | DONE |
| REQ-LIVE-SMOKE | §36 | acceptance | tests/live/smoke.test.ts | 4/4 PASS, $0.0295 est, read-only only; evidence/validation/live-smoke.txt | DONE |
| REQ-XAI-OPTIONAL | §22 | non-goal MVP | — | ACCEPTANCE limitation | DEFERRED |
| REQ-SKILL | §23 | skills | SKILL.md | file present | DONE |
| REQ-HOOKS | §24 | hooks | hooks/*.mjs | unit fixtures | DONE |
| REQ-OVERRIDES | §25 | classifier+cli | markers+flags | unit | DONE |
| REQ-FAIL-CLOSED | §26 | router+config | select/loader | unit | DONE |
| REQ-TESTS | §27 | tests/ | unit+integration | npm test | DONE |
| REQ-LIVE-OPTIN | §28 | tests/live | test:live | DONE (live smoke PASS) |
| REQ-ACCEPTANCE | §29-32 | artifacts | ACCEPTANCE.json | final | DONE |
| REQ-THREAT-MODEL | §7.4 | security | docs/THREAT-MODEL.md | review | DONE |
| REQ-NON-GOALS | §34 | architecture | docs | review | DONE |

## Contradiction check

| Topic | Resolution |
| --- | --- |
| Model IDs | Prefer live `cmd --list-models` |
| MiniMax rates | Prefer official docs $0.30/$1.20/$0.06 |
| Write auth | `--apply` only |
| Fallback | Never for explicit `--model` |
| Live tests | Opt-in; PASS_WITH_LIMITATIONS if skipped |
| xAI | Optional, not MVP |
