# Amrita अ — v2

**A chat-first, project-aware, multi-channel agent operating system.** Typed from the wire in:
a pnpm monorepo whose foundation is a Zod **event protocol** and an event-sourced **store**.

This is the greenfield v2. The original single-package, zero-runtime-dependency implementation
(v0.1) is frozen in its own repo at tag `v0.1` and serves as a reference; see
[`docs/v01-harvest.md`](docs/v01-harvest.md) for the migration map.

## Status — usable product loop (Phases 0–5 first slices)

Implemented and tested:

- **`@amrita/protocol`** — the constitution. A namespaced Zod event protocol (envelope + ~54 typed
  payloads), the lane contract (`LaneMandate` / `MergeReport`), the client/server RPC union, and
  entity row schemas. `model.delta` is stream-only and never persisted.
- **`@amrita/store`** — a Drizzle + better-sqlite3 event store. Hand-written reversible migrations,
  WAL, a per-conversation monotonic `seq` assigned inside the append transaction, the hybrid
  user-message model, FTS5 ranked search (messages + memory), entity tables with their invariants
  (append-only decisions, `secret_ref` env-name-only, settings secret tripwire), and >32 KB
  tool-payload spill-to-artifact.
- **`@amrita/daemon`** — the `amritad` kernel + JSON-RPC over stdio and HTTP/WS, bearer-token
  auth, the chat-turn provider boundary (deterministic `mock` + env-backed anthropic/openai
  adapters), **live `model.delta` streaming**, lane execution (opt-in, confined, cancellable),
  and a grouped `doctor` report.
- **`@amrita/cli`** — `amrita` for projects, conversations, chat, tasks/decisions/memory,
  accounts (env-name refs only), channels, lanes, and `doctor`.
- **`@amrita/channels`** — web transport + Telegram skeleton (deny-by-default owner allowlist,
  pairing codes; a live bot runner is not bundled yet and every surface says so honestly).
- **`@amrita/web`** — the operator UI: project sidebar, live-streaming chat transcript
  (WebSocket + replay fallback), memory/tasks/decisions panels with typed writes, a Lanes panel
  (start dry-run/real-gated, observe, cancel), runtime doctor chips, access-token panel,
  RTL-aware, usable on narrow viewports.

**Try it:** [`docs/smoke.md`](docs/smoke.md) walks the whole loop in ten minutes — daemon → web →
streamed chat → project knowledge → safe lane → doctor.

## Quick start

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
pnpm amritad -- --db ~/.amrita/amrita.db --http --port 7460
pnpm --filter @amrita/web dev   # http://localhost:5173
```

## Why a rewrite

v0.1 proved the product (chat-first, project memory, honest integrations, Claude Code as a lane).
v2 keeps that identity but makes the contracts **typed and enforced**: one Zod protocol that every
channel, the daemon, the store, and every lane must speak, and an event-sourced store that can
replay a conversation deterministically.

## License

MIT © Nethanel Kol
