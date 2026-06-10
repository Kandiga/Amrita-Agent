# ADR-0001: Headline decisions (D1–D10)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** Greenfield v2 of Amrita. v0.1 proved the product as a single zero-dependency package;
  v2 makes the boundary contracts typed and enforced. These ten decisions frame the whole build.

## Decisions

### D1 — pnpm workspaces monorepo
Separate publishable concerns (`protocol`, `store`, `providers`, `daemon`, `channels`, `web`,
`lanes/*`) with workspace protocol deps. *Why:* the protocol must be importable by every other
package as the single source of types. *Alternative rejected:* single package (v0.1's shape) — it
blurred the boundaries we now want enforced.

### D2 — Zod is the constitution
Every event, RPC frame, and persisted row is a Zod schema in `@amrita/protocol`; nothing crosses a
boundary unparsed. *Why:* one validation layer for wire, storage, and lanes; runtime safety at the
edges, inferred types inside. *Cost:* schemas must be maintained as the contract — acceptable, it's
the point.

### D3 — Event-sourced store, Drizzle schema + better-sqlite3 runtime
Append-only `events` is truth; read models are materialized. Drizzle defines tables; better-sqlite3
runs the imperative paths (`seq`, FTS, spill). *Why:* deterministic replay; precise transaction
control where it matters. *Revisit* if typed reads dominate later phases.

### D4 — Per-conversation monotonic `seq`
Assigned inside the append transaction; `UNIQUE(conversation_id, seq)` enforces it. *Why:* a total
order within a conversation for replay and `sinceSeq` resume, without a global sequence bottleneck.

### D5 — Role-based providers (`fast`/`main`/`deep`) + `auto`
Roles map to concrete provider+model; `auto` resolves at runtime to the best available (login →
configured key → local). *Why:* carried from v0.1 — a fresh box is never trapped on a broken
default; deep/fast split lets cheap turns stay cheap.

### D6 — Hono + ws daemon
One localhost daemon: Hono for HTTP control, a WebSocket for the live event stream; the RPC union is
the only wire vocabulary. *Why:* small, typed, standard; localhost-bound with a TLS proxy in front
(as v0.1).

### D7 — Lanes are mandate → report
A lane receives a `LaneMandate` and returns a `MergeReport`; nothing else crosses the boundary.
*Why:* a lane is delegated, budgeted, scoped work — the contract makes budget/scope/approval
explicit and auditable.

### D8 — `model.delta` is stream-only
Token deltas stream to clients but are never persisted; the store rejects them. Persist
`model.response` + `model.usage`. *Why:* keep the log compact and replay clean.

### D9 — Spill tool payloads > 32 KB
Large `tool.completed` results go to an artifact file; the event keeps `{spilledArtifactId,
preview}`. *Why:* bounded event rows; the full payload stays retrievable.

### D10 — ULIDs everywhere
Sortable, URL-safe domain ids; integer rowids stay inside SQLite. *Why:* k-sorted ids ease ordering
and debugging; no domain coupling to autoincrement.

## Consequences

The protocol and store packages are the load-bearing Phase-0 deliverable; everything else depends on
them. Any change to an event type, the envelope, or the store schema requires a new ADR and an
append-only migration.
