# Security Review

## Controls implemented

| Control | Status |
| --- | --- |
| No shell interpolation | PASS — argv arrays, `shell: false` |
| Task not in argv | PASS — stdin packets |
| Model id metachar filter | PASS |
| Apply-gated auto-accept | PASS |
| YOLO not default | PASS — `--unsafe-yolo` only |
| Recursion blocked | PASS — env depth/child + hooks |
| Role output untrusted | PASS — envelope parse only |
| Secret redaction in telemetry | PASS |
| No credential storage | PASS |
| Dirty worktree gate on run/orch `--apply` | PASS |
| Fail-closed config | PASS |
| No silent explicit model fallback | PASS |
| No double promotional discount | PASS |

## Residual risks

- Child CommandCode sessions still have their normal tool surface; hooks must be installed by the operator for PreToolUse denial (see `docs/OPERATIONS.md` § Operator hooks).
- Network deal refresh trusts HTTPS content only for reachability in MVP; rates come from validated snapshots/seeds.
- Live subprocess timeout/kill-tree behavior is best-effort on POSIX.

## Verdict

Security acceptance criteria for MVP: **met** under deterministic testing.
