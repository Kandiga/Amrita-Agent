# Amrita अ — v2

**A chat-first, project-aware, multi-channel agent operating system.** Typed from the wire in:
a pnpm monorepo whose foundation is a Zod **event protocol** and an event-sourced **store**.

This is the greenfield v2. The original single-package, zero-runtime-dependency implementation
(v0.1) is frozen in its own repo at tag `v0.1` and serves as a reference; see
[`docs/v01-harvest.md`](docs/v01-harvest.md) for the migration map.

## Status — usable product loop with first-run onboarding

Implemented and tested (see [`docs/progress/amrita-v2-upgrade-ledger.md`](docs/progress/amrita-v2-upgrade-ledger.md)
for the full phase history and [`docs/strategy/hermes-parity-roadmap.md`](docs/strategy/hermes-parity-roadmap.md)
for what is matched vs planned against a Hermes-grade operational skeleton):

- **`@amrita/protocol`** — the constitution. A namespaced Zod event protocol (envelope + 60+ typed
  payloads), the lane contract (`LaneMandate` / `MergeReport`), the client/server RPC union, and
  entity row schemas. `model.delta` is stream-only and never persisted.
- **`@amrita/store`** — a Drizzle + better-sqlite3 event store. Hand-written reversible migrations,
  WAL, a per-conversation monotonic `seq` assigned inside the append transaction, the hybrid
  user-message model, FTS5 ranked search (messages + memory), entity tables with their invariants
  (append-only decisions, `secret_ref` env-name-only, settings secret tripwire), and >32 KB
  tool-payload spill-to-artifact.
- **`@amrita/daemon`** — the `amritad` kernel + JSON-RPC over stdio and HTTP/WS, bearer-token
  auth, and the chat-turn provider boundary. A render-from-metadata **provider catalog**
  (subscription login via the Claude Code CLI — no key ever exists; API keys for
  Anthropic/OpenAI/OpenRouter/Gemini; OpenAI-compatible local endpoints; Codex detection-only),
  with live bounded probes and honest states; a **coding-runtime registry**; deterministic role
  resolution (session > lane > project > global > auto); **live `model.delta` streaming**; lane
  execution (opt-in, confined, cancellable, operator-approval-gated); and an async **grouped
  `doctor`** that is the single truth source across home/store/providers/runtimes/lanes/channels/
  connectors/auth.
- **`@amrita/cli`** — `amrita` for first-run **`setup`** (sectioned + `--full` + per-section),
  **`model`**, **`config`** (non-secret only; secret-like keys/values refused), **`doctor`**
  (`--fix` tightens permissions), `provider`/`runtime` status, `connectors`/`github` import,
  projects, conversations, chat, tasks/decisions/memory, accounts (env-name refs only), channels,
  and lanes.
- **`@amrita/channels`** — web transport + a **live Telegram operator runner** (`amritad --telegram`):
  owner-gated long poll, deny-by-default allowlist, pairing codes, and operator commands
  (`/status /lanes /approvals /approve /deny /stop`). It refuses to start unconfigured, and
  `channels.list` + `doctor` report it `ready` only while the runner is actually live.
- **`@amrita/web`** — the operator UI / **Project Brain**: project sidebar, live-streaming chat
  transcript (WebSocket + replay fallback), project brief + open questions + risks + milestones
  (ADR-0018, evidence-enforced lifecycles), an activity timeline derived from the event log,
  memory/tasks/decisions panels with typed writes, rule-based next actions, a Lanes panel
  (start dry-run/real-gated, observe, cancel), runtime doctor chips, access-token panel,
  RTL-aware, usable on narrow viewports.

**Try it:** [`docs/smoke.md`](docs/smoke.md) walks the whole loop in ten minutes — daemon → web →
streamed chat → project knowledge → safe lane → doctor.

## Quick start — 60 seconds, no sudo

```bash
curl -fsSL https://raw.githubusercontent.com/Kandiga/Amrita-Agent/v2-main/scripts/install.sh | bash
amrita open      # starts the daemon + web UI and opens Amrita in your browser
```

`amrita open` starts whatever is not already running (the daemon and the web
UI), waits until both are ready, and opens **one URL** — with the control token
handed to the browser automatically (you never copy-paste a token). On a
headless host it prints the URL instead of claiming a browser opened.

Then connect your own brain (optional — a deterministic **Mock/Demo** mode works
with zero credentials):

```bash
amrita setup     # Claude Pro/Max · ChatGPT+Codex · an Anthropic/OpenAI/OpenRouter/Gemini API key · a local Ollama/vLLM endpoint · or Mock
amrita doctor    # core readiness, with the exact fix command for anything missing
```

Every connection tells you **who is billed** before you connect — “this uses
your local Claude login”, “this bills your OpenAI API account”, or “this stays
local” — never an ambiguous “connected”. `amrita doctor`’s top line reflects
**core** readiness only (your brain + the local UI); optional integrations
(Telegram, GitHub) and private modules stay neutral until you enable them, so a
fresh install is never falsely red.

**Supported platforms** (honest matrix):

| Platform | Status | Notes |
|---|---|---|
| Linux x64 | **supported** | primary target; CI runs the full gate + clean-install smoke |
| WSL2 | **supported** | same path as Linux |
| macOS (x64/ARM64) | **experimental** | the install path is written for it; not yet proven in CI |
| Native Windows | **not supported** | use WSL2 |

### Lifecycle

```bash
amrita open      # start daemon + web, open the URL (idempotent — reuses what's already up)
amrita doctor    # core/optional/private readiness + machine-readable `--json`
amrita setup     # (re)connect a brain, roles, coding runtime, allowed project folders
```

**Where your data lives** (all under `~/.amrita`, override with `AMRITA_HOME`):

| Path | Holds |
|---|---|
| `~/.amrita/amrita.db` | the event-sourced store (projects, conversations, events, FTS5 search) |
| `~/.amrita/secrets.env` | secret **values** only (0600) — env-var **names** are all that ever reach the DB |
| `~/.amrita/config.json` | non-secret operator config (`amrita config show`); never holds a secret |

`amrita config path` prints these; `amrita config set <key> <value>` edits non-secret preferences
(secret-like keys/values are refused and pointed at `secrets.env` / `amrita setup`).

Developing in a checkout:

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm amritad -- --http --port 7460   # DB defaults to ~/.amrita/amrita.db; prints a one-time token
pnpm --filter @amrita/web dev        # http://localhost:5173 (proxies /rpc + /events to :7460)
```

In HTTP mode every route except `GET /health` needs the bearer token `amritad` prints at startup
(or set `AMRITA_AUTH_TOKEN` for a stable one). `amrita open` hands it to the browser automatically
via a one-time `#token=` fragment; if you start the pieces by hand, paste it into the web app's
access-token panel.

## Why a rewrite

v0.1 proved the product (chat-first, project memory, honest integrations, Claude Code as a lane).
v2 keeps that identity but makes the contracts **typed and enforced**: one Zod protocol that every
channel, the daemon, the store, and every lane must speak, and an event-sourced store that can
replay a conversation deterministically.

## License

MIT © Nethanel Kol
