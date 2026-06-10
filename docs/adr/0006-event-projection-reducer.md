# ADR-0006: Same-transaction event projection reducer

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#1.1 added the entity tables; WO#1.2 froze the entity event taxonomy. WO#1.3 wires
  them together: a reducer that materializes read-model rows from events, in the **same transaction**
  as the event append, so the log and its projections can never diverge. Design informed by a study
  of Hermes Agent's write discipline (see `docs/hermes-architecture-notes.md`).

## Decision

### `appendEvent` is the single atomic event+projection boundary

`appendEvent(input)`:
1. `parseUnsealedEvent` (reject unknown type / bad payload), reject stream-only types **before** any
   transaction.
2. Open one `better-sqlite3` transaction and, inside it: assign the per-conversation monotonic `seq`,
   spill an oversized tool result, `parseEvent` the sealed event, **insert the event row**, then call
   `applyEventProjection(db, sealed)`, then touch `conversations.updated_at`.
3. Commit. If *anything* in step 2 throws — including a projection FK/CHECK/trigger violation — the
   whole transaction rolls back, so a failed projection leaves **no** event row.

`recordUserMessage` is now a thin convenience over `appendEvent` (emits a `message.user` event; the
projection writes the `messages` row). The former bespoke two-write method is gone.

### The reducer contract (`applyEventProjection(db, event)`)

- **Must run inside an open transaction** on the same `db`. It never opens or commits one itself.
- **Pure except for SQLite writes.** No filesystem, no network, no `Date.now()` — every timestamp is
  `event.ts`, so re-projecting the same event is deterministic (supports future replay/rebuild).
- **Deterministic dispatch** on `event.type`; events with no read-model are an explicit no-op (they
  still live in the event log).
- **Fails closed.** Any constraint violation throws and rolls back the event — there is no partial
  projection and no swallowed error.
- **Never writes a secret.** Provider events touch only `accounts.metadata_json` health fields, never
  `secret_ref`; `settings.updated` and `accounts` keep their ADR-0003 secret tripwires.
- **External side effects are out of scope.** Notifications, the agent loop, webhooks, and lane
  execution react to events *after commit*, keyed off the committed `seq` — never from inside the
  reducer.

### Identity rule

A `message.*` event projects to a `messages` row whose **id is the event id** — a deterministic 1:1
link, so `recordUserMessage` can return the row without a read-back, and replay is idempotent.

## Documented projection choices (production defaults)

- **All `message.*` (user/agent/system) materialize rows** and become FTS-searchable, not just user
  messages. `content_json` is the full event payload (so attachments survive); FTS indexes `$.text`.
- **`decision.*` is INSERT-only** — `decision.superseded` inserts a new row carrying `supersedes_id`;
  the reducer never UPDATE/DELETEs, so the append-only triggers (ADR-0003) are honored.
- **`memory.updated` / `memory.consolidated` are metadata projections.** The frozen WO#1.2 payloads
  carry *provenance, not content*, and `memory_entries.content` is `NOT NULL` with a generated
  `char_count`; so the reducer updates scope/project/source/`updated_at` of an **existing** row and is
  a **no-op if the row is absent**. Content-bearing creation of a memory row is a direct store concern
  (a future `putMemoryEntry`), deferred — not invented here. `memory.consolidated` marks the result
  row `source='consolidated'` and does **not** delete source rows (no destructive GC in the reducer).
- **`provider.*` updates only `accounts.metadata_json.health`** (`connected|degraded|restored`, with a
  `reason` for degraded), and only when `accountId` resolves to an existing row; otherwise no-op.
- **`connector.removed` deletes the read-model row.** Safe in an event-sourced model — the
  install/remove events remain in the log and the row is reconstructable.
- **`lane.*` drives the `lanes` state machine.** `lane.spawned` inserts using the envelope's
  `projectId`/`conversationId` (the payload lacks them) with a `'{}'` mandate placeholder; `lane.mandate`
  fills `mandate_json`/`budget_json`; progress→`running`, merge_report→`merging`(+`merge_json`),
  completed→`completed`, aborted→`aborted`. `lane.progress` is keyed by the **envelope** `laneId`.

## Known limitation (not changed here)

The tool-result **spill** still does its `writeFileSync` *inside* the transaction (pre-existing, WO#0).
On a rollback the orphaned artifact file is harmless (no DB row references it) but is litter. Moving
the file write to a post-commit step is a follow-up, out of WO#1.3 scope.

## Consequences

The store now has one write path with a uniform atomicity guarantee. Adding a new entity projection
is a new `case` in the reducer (plus its event type via an ADR). The reducer's purity + determinism
keeps the door open to a "rebuild read models from the event log" tool later.
