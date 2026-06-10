# Amrita अ — v2

**A chat-first, project-aware, multi-channel agent operating system.** Typed from the wire in:
a pnpm monorepo whose foundation is a Zod **event protocol** and an event-sourced **store**.

This is the greenfield v2. The original single-package, zero-runtime-dependency implementation
(v0.1) is frozen in its own repo at tag `v0.1` and serves as a reference; see
[`docs/v01-harvest.md`](docs/v01-harvest.md) for the migration map.

## Status — Phase 0 (foundation)

Implemented and tested in this scaffold:

- **`@amrita/protocol`** — the constitution. A namespaced Zod event protocol (envelope + ~40 typed
  payloads), the lane contract (`LaneMandate` / `MergeReport`), the client/server RPC union, and
  entity row schemas. `model.delta` is stream-only and never persisted.
- **`@amrita/store`** — a Drizzle + better-sqlite3 event store. Hand-written reversible migrations,
  WAL, a per-conversation monotonic `seq` assigned inside the append transaction, the hybrid
  user-message model (message row + event in one transaction), FTS5 ranked search over message
  text, and >32 KB tool-payload spill-to-artifact.

Later phases (daemon, providers, channels, web, lanes) are specified in [`docs/PLAN.md`](docs/PLAN.md).

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test
```

## Why a rewrite

v0.1 proved the product (chat-first, project memory, honest integrations, Claude Code as a lane).
v2 keeps that identity but makes the contracts **typed and enforced**: one Zod protocol that every
channel, the daemon, the store, and every lane must speak, and an event-sourced store that can
replay a conversation deterministically.

## License

MIT © Nethanel Kol
