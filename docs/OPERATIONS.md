# Operations

## Install

```bash
npm pack
npm install -g ./commandcode-deal-orchestrator-0.2.0.tgz
```

Or from source:

```bash
npm ci
npm run build
npm link
```

## Managed CommandCode integration lifecycle

`ccroute install` registers the Mod via official `cmd mods add` and writes a managed
manifest under `.commandcode/ccroute-install-manifest.json` (project) or
`~/.commandcode/ccroute-install-manifest.json` (user).

```bash
ccroute install                  # project (default)
ccroute install --user           # user/global (explicit)
ccroute install --skill --hooks  # optional surfaces
ccroute install --dry-run
ccroute install status
ccroute install update
ccroute install repair
ccroute uninstall
```

### Custody rules

- Official Mod manager owns `mods.sources` registration.
- Optional hook merges use ownership markers; unrelated settings/hooks are preserved.
- Update/repair refuse user-modified managed files unless `--force`.
- Uninstall removes only ccroute-owned files and settings entries — never full-backup restore over later user edits.
- Reject simultaneous `--project` and `--user`.

### Scope notes

| Surface | Project | User | Headless `-p` |
| --- | --- | --- | --- |
| Mod auto-routing | trust-gated | always | user / `--mod` only |
| Skill | optional | optional | loads when present |
| Hook fallback | optional | optional | defence-in-depth |

## First run

```bash
ccroute doctor
ccroute config validate
ccroute models list
ccroute deals status
ccroute decide "Summarize this repository"
ccroute explain "Refactor authentication across three services"
ccroute install --dry-run
```

## Config paths

- User: `~/.commandcode/deal-router.yaml`
- Project: `.commandcode/deal-router.yaml`
- State: `~/.commandcode/deal-router/`

## Telemetry

Append-only JSONL at `~/.commandcode/deal-router/telemetry.jsonl`. Disable with `--no-telemetry`.

## Skill

Copy or link `skills/commandcode-deal-orchestrator` into `~/.commandcode/skills/` or project `.commandcode/skills/`.

## Operator hooks (recommended)

Child `cmd` sessions still have a normal tool surface. Env markers
(`CCROUTE_CHILD`, `CCROUTE_DEPTH`, `CCROUTE_ROLE`) block nested **ccroute**
entry in-process, but PreToolUse hooks are the secondary defence that stops a
child shell from re-invoking `ccroute` / the package bin.

### What ships

| File | Event | Behavior |
| --- | --- | --- |
| `hooks/child-session-context.mjs` | `SessionStart` | When `CCROUTE_CHILD=1`, injects bounded role context |
| `hooks/child-recursion-guard.mjs` | `PreToolUse` (`shell`) | When `CCROUTE_CHILD=1`, **deny** shell that runs `ccroute` / package name |
| `examples/commandcode-settings.hooks.json` | settings fragment | Example merge into Command Code settings |

Hooks read JSON on stdin and write JSON on stdout. No `eval`. Outside child
sessions they are no-ops (`{}`).

### Install (project)

From the repo root (paths are relative to the Command Code project cwd):

```bash
# 1. Ensure hooks are present (shipped with the package / repo)
ls hooks/child-session-context.mjs hooks/child-recursion-guard.mjs

# 2. Merge the example into project settings
mkdir -p .commandcode
# If you have no settings yet:
cp examples/commandcode-settings.hooks.json .commandcode/settings.hooks.fragment.json
```

Merge the `hooks` object from `examples/commandcode-settings.hooks.json` into
your project `.commandcode/settings.json` (or user settings). Do **not** replace
an existing `permissions` / taste block — only add or extend `hooks`.

Minimal fragment:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ./hooks/child-session-context.mjs",
            "timeout": 2
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "shell",
        "hooks": [
          {
            "type": "command",
            "command": "node ./hooks/child-recursion-guard.mjs",
            "timeout": 2
          }
        ]
      }
    ]
  }
}
```

If you installed the package globally and the project has no local `hooks/`,
point `command` at absolute paths, for example:

```bash
node "$(npm root -g)/commandcode-deal-orchestrator/hooks/child-recursion-guard.mjs"
```

(Adjust for your package layout / `npm link` path.)

### Verify

```bash
# No-op outside child
echo '{}' | node ./hooks/child-recursion-guard.mjs
# expect: {}

# Deny nested ccroute when child marker is set
printf '%s' '{"tool_name":"shell","tool_input":{"command":"ccroute decide x"}}' \
  | CCROUTE_CHILD=1 node ./hooks/child-recursion-guard.mjs
# expect JSON with permissionDecision: "deny"

# Session context only when child
echo '{}' | CCROUTE_CHILD=1 CCROUTE_ROLE=executor node ./hooks/child-session-context.mjs
# expect additionalContext mentioning Role: executor
```

Package unit tests under `tests/unit/hooks.test.ts` exercise the same contracts.

### Notes

- Hooks are **operator-installed**. ccroute does not rewrite global Command Code
  settings automatically (by design — avoids clobbering taste/permissions).
- Recursion is still fail-closed via env even if hooks are missing; hooks close
  the residual “child shell re-runs ccroute” path (threat T-003 / T-004).
- Keep timeout small (2s); hooks must stay fast and side-effect free.
