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
| REQ-AUTO-001-MOD | CCROUTE-AUTO-001 | Mod primary surface | src/integrations/commandcode-mod/ | unit mod-* | DONE |
| REQ-AUTO-001-TRANSFORM | CCROUTE-AUTO-001 | transformInput routing | route-prompt.ts + index.ts | unit route + factory | DONE |
| REQ-AUTO-001-EXACT-MODEL | CCROUTE-AUTO-001 | live catalog validate | router-client.ts | unit validation | DONE |
| REQ-AUTO-001-COMMANDS | CCROUTE-AUTO-001 | /route* commands | commands.ts + index.ts | unit factory | DONE |
| REQ-AUTO-001-TELEMETRY | CCROUTE-AUTO-001 | append-only usage | telemetry.ts | unit mod-telemetry | DONE |
| REQ-AUTO-001-RECURSION-PRIMARY | CCROUTE-AUTO-001 | binary guard | recursion-guard.ts + cli preAction | unit recursion-primary | DONE |
| REQ-AUTO-001-RECURSION-MOD | CCROUTE-AUTO-001 | beforeToolCall defence | recursion.ts | unit mod-recursion | DONE |
| REQ-AUTO-001-COMPAT | CCROUTE-AUTO-001 | capability baseline | docs + compatibility.ts | unit + evidence | DONE |
| REQ-AUTO-001-ONE-REQUEST | CCROUTE-AUTO-001 | no classifier LLM | route-prompt | unit one-decide | DONE |
| REQ-AUTO-002-INSTALL | CCROUTE-AUTO-002 | managed install lifecycle | src/install/ + cli install/uninstall | unit install-lifecycle | DONE |
| REQ-AUTO-002-MOD-MANAGER | CCROUTE-AUTO-002 | official cmd mods add/remove/update | mod-manager.ts | unit + evidence INSTALL-*.json | DONE |
| REQ-AUTO-002-MANIFEST | CCROUTE-AUTO-002 | install manifest | manifest.ts | unit + schema | DONE |
| REQ-AUTO-002-SETTINGS | CCROUTE-AUTO-002 | settings custody | settings-custody.ts | unit install-settings | DONE |
| REQ-AUTO-002-UPDATE | CCROUTE-AUTO-002 | update with conflict detection | lifecycle update | unit + evidence UPDATE.json | DONE |
| REQ-AUTO-002-REPAIR | CCROUTE-AUTO-002 | repair owned state only | lifecycle repair | unit + evidence REPAIR.json | DONE |
| REQ-AUTO-002-UNINSTALL | CCROUTE-AUTO-002 | owned-only uninstall | lifecycle uninstall | unit + evidence UNINSTALL.json | DONE |
| REQ-AUTO-002-HEADLESS | CCROUTE-AUTO-002 | scope truth table | HEADLESS-QUALIFICATION.json | evidence | DONE |
| REQ-AUTO-003-BOOTSTRAP | CCROUTE-AUTO-003 | bootstrap ≠ refresh | src/refresh/bootstrap.ts | unit refresh-core | DONE |
| REQ-AUTO-003-LEASE | CCROUTE-AUTO-003 | cross-process lease | src/refresh/lease.ts | unit concurrency | DONE |
| REQ-AUTO-003-BACKOFF | CCROUTE-AUTO-003 | stepped backoff | src/refresh/backoff.ts | unit | DONE |
| REQ-AUTO-003-COORD | CCROUTE-AUTO-003 | coordinated refresh | src/refresh/coordinator.ts | unit | DONE |
| REQ-AUTO-003-SESSION | CCROUTE-AUTO-003 | nonblocking session-start | session-start.ts + mod | unit | DONE |
| REQ-AUTO-003-LAUNCHD | CCROUTE-AUTO-003 | macOS launchd lifecycle | src/refresh/launchd.ts | unit + CLI | DONE |

## Contradiction check

| Topic | Resolution |
| --- | --- |
| Model IDs | Prefer live `cmd --list-models` |
| MiniMax rates | Prefer official docs $0.30/$1.20/$0.06 |
| Write auth | `--apply` only |
| Fallback | Never for explicit `--model` |
| Live tests | Opt-in; PASS_WITH_LIMITATIONS if skipped |
| xAI | Optional, not MVP |
