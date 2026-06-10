# ADR-0007: Public Store API, memory content, and query semantics

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#1.3 made `appendEvent` the atomic event+projection boundary but left consumers
  reaching into tables with raw SQL, and left `memory.updated/consolidated` unable to create a
  `memory_entries` row (content wasn't carried, yet `content` is `NOT NULL`). WO#1.4 builds the typed
  Store API the daemon/kernel will use, and closes the memory gap.

## Decision 1 — Memory content lives inline in the event

`memory.updated` and `memory.consolidated` gain a required `content: string (1..4000)` field;
`memory.updated` drops the now-redundant `charCount` (the table derives `char_count` from `content`).

*Why inline:* a memory entry is **bounded to 4000 chars by the table CHECK**, so there is no
size/bloat concern, and keeping content in the event makes `memory_entries` a true, rebuildable
projection (consistent with `message.*` content living in the event). A `contentHash` + external blob
indirection was considered and rejected — it only pays off for large/unbounded content, which memory
is not.

This **supersedes the memory projection decision in ADR-0006**: the reducer now **upserts** a
`memory_entries` row (create-or-update) from the event content, instead of being a metadata-only
no-op-if-absent.

**Memory secret boundary.** Memory content is the user's own knowledge — it is *data*, the thing the
store exists to hold — so it is stored as written and is **not** subject to a secret-key tripwire
(that would corrupt legitimate notes with false positives). The no-secret discipline applies to the
*credential* surfaces, not user content: the Store API never copies a `secret_ref` or any
`accounts`/`settings` secret into memory, and `secret_ref` values never enter events at all. Settings
keys and `accounts.secret_ref` keep their ADR-0003 tripwires unchanged.

## Decision 2 — `provider.connected` upserts the account row

To give `connectProviderAccount(...)` a real effect, `provider.connected` now **creates** the
`accounts` row if it is missing (id, provider, `auth_mode`, health=`connected`), or updates health if
present. `secret_ref` is **never** set by an event — it stays `NULL`; binding a secret reference is a
separate secure config path (out of WO#1.4). `provider.degraded`/`provider.restored` remain
health-only updates of an existing row (no-op if absent — you cannot degrade an account never
connected). This revises the ADR-0006 "no-op if absent" note for `provider.connected` only.

## Decision 3 — Every entity write goes through an event; the envelope carries context

The public write APIs (`createTask`, `recordDecision`, `putMemoryEntry`, `updateSetting`,
`installConnector`, `connectProviderAccount`, …) construct a **validated protocol event** and call
`appendEvent`; they never write a table directly. Consequences of the envelope being mandatory:

- **Global config events still carry a `conversationId`.** `settings`/`connectors`/`accounts` are
  global, but every event belongs to a conversation, so these APIs take the originating (or a system)
  conversation. The daemon will own a system conversation for admin actions.
- **Memory envelope `projectId` is *context*, payload `projectId` is *ownership*.** For
  `scope='user'` the payload omits `projectId` (so the table's scope/project CHECK holds) while the
  envelope still carries the context project. The API derives this from `scope`.

Default `origin` for entity-management events is `system`; callers may override.

## Decision 4 — Read APIs; memory search is a documented LIKE fallback

Typed read helpers (`listTasks`, `listDecisions`, `getDecisionHistory`, `getConversationTree`,
`listConnectors`, `listAccounts`, `getAccountHealth`, `listLanes`, `getSetting`) return mapped
camelCase rows. `getConversationTree` and `getDecisionHistory` use recursive CTEs over
`conversations.parent_id` and `decisions.supersedes_id`.

**`searchMemory` uses a `LIKE` scan, not FTS** — there is no FTS index on `memory_entries` (only on
`messages`). A dedicated `memory_fts` is a future migration (deferred); `searchMemory` escapes
`%`/`_`/`\` and is documented as best-effort substring match until then.

## Decision 5 — Spill file write moved after commit

The tool-result spill now writes its file **after** the transaction commits (the `artifacts` row +
payload rewrite stay in-tx). This removes the WO#1.3 orphan-file-on-rollback debt. Trade-off: a crash
between commit and the file write leaves a row whose file is missing — recoverable, since the event
still carries the `preview`, and strictly better than littering files on every rolled-back spill.

## Consequences

`memory.updated` payload changed (content added, charCount removed) — a protocol change recorded
here. The daemon must use the Store API, never raw SQL. The only deferred items are a `memory_fts`
index and a secure `secret_ref`-binding config path.
