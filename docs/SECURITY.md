# Security

- `spawn` with `shell: false` and argv arrays only
- Task packets on stdin
- Model IDs validated against forbidden shell metacharacters
- `--auto-accept` only when caller passes `--apply`
- `--yolo` only via explicit `--unsafe-yolo` with warning
- Recursion blocked via `CCROUTE_CHILD` / `CCROUTE_DEPTH`
- Hooks parse JSON without `eval`
- Telemetry redacts common secret patterns; no source file bodies by default
- No credential persistence by ccroute
- No automatic git push/force/history rewrite
- Path policy rejects symlink escapes outside intended roots when used
