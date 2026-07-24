# Deal Source Policy

1. Official source: https://commandcode.ai/docs/resources/pricing-limits
2. Live model identities: `cmd --list-models`
3. Normal routing uses last valid local snapshot only.
4. `deals refresh` / `models refresh` never replace a valid snapshot with partial data.
5. Network failure → preserve prior snapshot, report error, nonzero exit.
6. Bundled seed dated 2026-07-23 is replaceable, not permanent truth.
7. `post_discount` rates must not receive a second promotional multiplier.
8. Free models may be capacity-limited; `--no-free` excludes them.
