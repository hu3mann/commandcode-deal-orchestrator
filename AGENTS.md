# AGENTS.md

- Primary bin: `ccroute`
- Stack: TypeScript ESM, Zod, Vitest, Commander, Biome
- Never invent CommandCode model IDs; use `cmd --list-models`
- Prefer official pricing over folklore
- `decide` must never spawn a model
- Writes require explicit `--apply`
- Run `npm run typecheck && npm run lint && npm test` before claiming done
