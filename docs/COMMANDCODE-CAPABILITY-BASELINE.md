# CommandCode Capability Baseline

Captured: 2026-07-23  
Local CLI: Command Code **v1.3.1**  
Auth: authenticated (`cmd status --json`)

## Classification legend

- **DOCUMENTED** — official docs
- **LOCALLY_OBSERVED** — verified on this machine
- **INFERRED** — reasonable but not fully proven
- **UNSUPPORTED** — must not be depended on

## Probes (sanitized)

| Command | Result |
| --- | --- |
| `command -v cmd` | LOCALLY_OBSERVED: present on PATH (mise shim) |
| `cmd --version` | LOCALLY_OBSERVED: `1.3.1` |
| `cmd --help` | LOCALLY_OBSERVED: full flag set below |
| `cmd --list-models` | LOCALLY_OBSERVED: 47 models |
| `cmd status --json` | LOCALLY_OBSERVED: `authenticated=true`, default model `deepseek/deepseek-v4-flash` |

## Integration surface

| Capability | Status | Notes |
| --- | --- | --- |
| `cmd --print` / `-p` | DOCUMENTED + LOCALLY_OBSERVED | Headless mode |
| `cmd --model` / `-m` | DOCUMENTED + LOCALLY_OBSERVED | Session model |
| `cmd --max-turns` | DOCUMENTED + LOCALLY_OBSERVED | Print-mode cap; exit 8 on hit |
| `cmd --plan` | DOCUMENTED + LOCALLY_OBSERVED | Read-only plan mode |
| `cmd --auto-accept` | DOCUMENTED + LOCALLY_OBSERVED | Write permission mode |
| `cmd --yolo` | DOCUMENTED + LOCALLY_OBSERVED | Dangerous; never default |
| `cmd --skip-onboarding` | DOCUMENTED + LOCALLY_OBSERVED | Automation |
| `cmd --list-models` | DOCUMENTED + LOCALLY_OBSERVED | Live identity source |
| `cmd status --json` | DOCUMENTED + LOCALLY_OBSERVED | Auth probe |
| `cmd --output-format json` | DOCUMENTED | NDJSON events |
| `cmd --trust` | DOCUMENTED + LOCALLY_OBSERVED | Skip project trust prompt |
| Skills (`SKILL.md`) | DOCUMENTED | User/project skill dirs |
| Hooks (SessionStart, PreToolUse, …) | DOCUMENTED | stdin/stdout JSON |
| Mods | DOCUMENTED | Not used for routing MVP |
| Per-agent model field | UNSUPPORTED | Custom agents lack documented model field |
| `setModel()` / transformInput API | UNSUPPORTED | Discarded folklore |
| Internal session file formats | UNSUPPORTED | Do not depend |

## Model ID corrections (packet → live)

| Packet | Live |
| --- | --- |
| `MiniMaxAI/MiniMax-M3` | `minimaxai/minimax-m3` |
| `grok-4.5` | `xai/grok-4.5` |
| `tencent/Hy3` free | expired; live paid id `tencent/hy3-paid` |

## Pricing notes (official docs 2026-07-23)

- DeepSeek V4 Pro / MiMo post-discount rates match seed packet.
- MiniMax M3 official post-discount: **$0.30 / $1.20 / $0.06** (not packet 0.225/0.90). Prefer official.
- Free optional: `poolside/laguna-s-2.1-free`, `inclusionai/ling-3.0-flash-free` (expires 2026-08-02 PT).
- Claude Sonnet 5 intro pricing reverts 2026-09-01.

## Unstable dependencies

None required. Deal refresh may optionally fetch the official pricing HTML page; failures preserve prior snapshot.
