# ADR-0004: Entity event taxonomy (tasks, decisions, memory, providers, connectors, settings)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#1.1 added the entity tables (`tasks`, `decisions`, `memory_entries`, `lanes`,
  `accounts`, `connectors`, `settings`, `conversations.parent_id`). The constitution says the event
  protocol and the store schema are co-equal: rows must be produced by **typed, first-class events**,
  not ad-hoc writes. WO#1.2 (this ADR) ratifies the event taxonomy the future projection reducer
  (WO#1.3) will consume. **No projection is implemented here** — this is protocol + docs + tests only.

## Rule (restated)

**The event taxonomy changes only via an ADR.** Adding, removing, renaming, or changing the payload
of an event type requires a numbered ADR explaining why. This ADR is the authority for the entries
below; later changes need their own.

## New event types

| Event | Persisted? | Purpose / projection target |
|-------|-----------|------------------------------|
| `task.created` | yes | insert a `tasks` row (provenance: project/conversation/source message/lane) |
| `task.updated` | yes | patch a `tasks` row (status/title/body) |
| `task.completed` | yes | terminal convenience → `status='done'` |
| `decision.recorded` | yes | insert a `decisions` row (fresh decision) |
| `decision.superseded` | yes | insert a `decisions` row carrying `supersedesId` |
| `memory.updated` | yes | **upsert** a `memory_entries` row (create or update) |
| `memory.consolidated` | yes | record that N entries were merged into one |
| `provider.connected` | yes | an account/provider became usable |
| `provider.degraded` | yes | health dropped (credit/login/endpoint) — carries `reason` |
| `provider.restored` | yes | health recovered |
| `connector.installed` | yes | insert a `connectors` row |
| `connector.updated` | yes | status/config change (no secrets) |
| `connector.removed` | yes | connector removed |
| `settings.updated` | yes | upsert a `settings` row (non-secret) |

All payloads are `.strict()` Zod schemas; ids are ULIDs (`idSchema`). None are stream-only.

## Reconciliations & deviations (documented, as the WO requires)

1. **`memory.updated` payload changed** from `{ path }` (a WO#0 vault-file placeholder) to row
   provenance `{ entryId, scope, projectId?, charCount?, source?, sourceMessageId? }`. This is a
   **payload reconciliation, not a rename** — the name predates the WO#1.1 `memory_entries` model and
   now points at it. Rationale: projection needs the row identity, not a file path.
2. **`memory.written` is kept unchanged** (`{ path, bytes }`) as the **markdown-vault file-export
   signal**, deliberately distinct from the row events. Per `v01-harvest.md`, the vault is a
   *projection* of the rows, not the source of truth; this event records that a file was written.
   It is not a `memory_entries` event and the WO#1.3 reducer ignores it for row state.
3. **`task.completed` is retained alongside `task.updated`** even though completion is expressible as
   `task.updated{status:'done'}`. It is a first-class terminal signal channels can subscribe to; the
   reducer treats it as `status='done'`.
4. **`settings.updated` rejects secret-ish keys at the schema** (`secret`/`api_key`/`apikey`/`token`/
   `password`, case-insensitive) via a Zod `.refine`, mirroring the store's `settings` CHECK
   (ADR-0003). Defense-in-depth: a secret never reaches the wire or the DB.
5. **`provider.*` is a new namespace** distinct from `channel.*`. `channel.connected` is about a
   message channel (web/telegram); `provider.*` is about a model-provider account/health.

## Invariants preserved

- **`model.delta` remains the only stream-only type.** No new stream-only events are introduced.
- No existing event was renamed. Only `memory.updated`'s payload was reconciled (item 1).
- Every payload is strict (unknown keys rejected).
- No secrets in any payload: `accounts` events carry `secret_ref` *names* only (handled in WO#1.3);
  `settings.updated` blocks secret-ish keys; `connector.updated` carries field names, not values.

## Consequences

WO#1.3 can implement the generalized `applyEvent(tx, event)` projection against a now-fixed,
validated taxonomy — no inventing events mid-reducer. The protocol's `EventType` union grows by 14;
`STREAM_ONLY_TYPES` is unchanged.
