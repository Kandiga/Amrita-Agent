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

## Quick start

End-user install (Linux/macOS/WSL — checks prerequisites, installs launchers, optional service):

```bash
curl -fsSL https://raw.githubusercontent.com/Kandiga/Amrita-Agent/v2-main/scripts/install.sh | bash
amrita setup     # choose a brain (subscription login / API key / local endpoint) + Telegram
amrita doctor    # verify everything, with exact fix commands
```

Before you run `amrita setup`, `amrita doctor` exits **`ok with warnings`** — that is expected: a
fresh machine has no brain, no Telegram token, and no stable control-surface token yet. Each
warning carries the exact command to clear it; nothing is faked green.

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
(or set `AMRITA_AUTH_TOKEN` for a stable one); paste it into the web app's access-token panel.

## Why a rewrite

v0.1 proved the product (chat-first, project memory, honest integrations, Claude Code as a lane).
v2 keeps that identity but makes the contracts **typed and enforced**: one Zod protocol that every
channel, the daemon, the store, and every lane must speak, and an event-sourced store that can
replay a conversation deterministically.

## License

MIT © Nethanel Kol
