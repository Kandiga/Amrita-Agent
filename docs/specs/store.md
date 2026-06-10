# Spec: the store

`@amrita/store` is the event-sourced persistence layer. The hand-written SQL migration
(`migrations/0000_init.sql`) is the source of truth for the schema; `src/schema.ts` is the Drizzle
mirror (kept in lock-step, used for typed queries and drizzle-kit generation in later phases); the
runtime (`src/store.ts`) drives better-sqlite3 directly.

## Why better-sqlite3 directly (not Drizzle's query builder) at runtime

Three behaviours need precise SQL/transaction control that an ORM obscures: per-conversation `seq`
assignment inside the append transaction, the FTS5 virtual table + triggers, and the spill side
effect. The Drizzle schema remains canonical for table definitions and future typed reads. This is
recorded as ADR-0001 D3; revisit if/when reads dominate.

## Tables

- **projects** `(id, slug unique, name, root?, created_at, updated_at)`
- **conversations** `(id, project_id→projects, title?, created_at, updated_at, archived_at?,
  parent_id?)` — `parent_id` is a trigger-enforced self-reference (lineage; added in `0001`).
- **messages** `(id, conversation_id→conversations, turn_id?, role, content_json, content*, created_at)`
  — `content` is a VIRTUAL generated column = `json_extract(content_json,'$.text')`, used as the FTS
  external-content source.
- **events** `(id, seq, ts, project_id, conversation_id→conversations, turn_id?, lane_id?, origin,
  channel?, type, payload_json)` with `UNIQUE(conversation_id, seq)` and an index on
  `(conversation_id, seq)`.
- **artifacts** `(id, conversation_id?, kind, path, bytes, created_at)`
- **messages_fts** — FTS5 external content `content='messages', content_rowid='rowid'`, kept in sync
  by `messages_ai/ad/au` triggers that index `json_extract(content_json,'$.text')`.
- **schema_migrations** `(version, applied_at)`

### Entity baseline (migration `0001_full_store_schema`, ADR-0003)

- **tasks** `(id, project_id→projects CASCADE, conversation_id?→conversations SET NULL,
  source_message_id?→messages SET NULL, lane_id?, status[now|later|done|dropped], title, body?,
  created_at, updated_at)`.
- **decisions** `(id, project_id→projects, conversation_id?, source_message_id?,
  supersedes_id?→decisions, text, created_at)` — **append-only**: `BEFORE UPDATE`/`BEFORE DELETE`
  triggers `RAISE(ABORT)`; correct by inserting a superseding row.
- **memory_entries** `(id, scope[user|project], project_id?→projects CASCADE, content,
  char_count*, source?, source_message_id?→messages SET NULL, created_at, updated_at)` —
  `char_count` is generated `length(content)`; CHECKs enforce scope/`project_id` consistency and a
  ≤4000-char budget. Full-text searched via **`memory_entries_fts`** (FTS5 external content, migration
  `0002`).
- **lanes** `(id, project_id→projects CASCADE, conversation_id→conversations CASCADE, kind,
  status[spawned|running|merging|completed|aborted], mandate_json, budget_json?, merge_json?,
  created_at, updated_at)`.
- **accounts** `(id, provider, label?, auth_mode[api_key|subscription_cli|local_endpoint|oauth],
  secret_ref?, metadata_json?, created_at, updated_at, UNIQUE(provider,label))` — `secret_ref` is an
  ENV-NAME (CHECK: `^[A-Z][A-Z0-9_]*$` via GLOB), **never a secret value**.
- **connectors** `(id, slug unique, kind, status[needs_setup|ready|error|disabled], manifest_json?,
  config_json?, created_at, updated_at)` — no secrets in `config_json`.
- **settings** `(key, value_json, updated_at)` — CHECK rejects keys containing
  `secret`/`api_key`/`apikey`/`token`/`password`.

## Migrations (`migrate.ts`)

- `MIGRATIONS` is an ordered, append-only list. Never edit a shipped migration; add the next one.
- `migrateUp(db)` applies every unrecorded migration in a transaction, recording its version.
- `migrateDown(db, toVersion?)` reverts highest-first using the paired `.down.sql`.
- `currentVersion(db)` reports the highest applied version (or -1).
- Migrations: `0000_init` (spine), `0001_full_store_schema` (entity baseline), `0002_memory_fts`
  (memory FTS5).
- **Acceptance:** up → down → up across all migrations leaves an identical schema and an idempotent
  second `up` applies 0; targeted `migrateDown(db, N)` reverts only versions above `N` (e.g. down to 1
  drops `memory_entries_fts` but keeps `memory_entries`).

## The store API (`store.ts`)

- `openStore({path, spillDir?})` — opens SQLite, sets `journal_mode=WAL`, `foreign_keys=ON`,
  `busy_timeout`, and runs `migrateUp`.
- `appendEvent(unsealed)` — the **central write path**. Validates (`parseUnsealedEvent`), rejects
  stream-only types, then in one transaction: assigns `seq = COALESCE(MAX(seq),0)+1`, spills an
  oversized tool result, inserts the event row, runs `applyEventProjection` (read-model projection),
  touches `conversations.updated_at`, and returns the sealed `AmritaEvent`. If projection fails, the
  event insert rolls back too — there is no event without its projection.
- `recordUserMessage({projectId, conversationId, text, turnId?, channel?})` — a thin convenience over
  `appendEvent`: emits a `message.user` event whose projection materializes the `messages` row (id ==
  event id) in the same transaction. (Formerly a bespoke two-write method; now the generalized path.)
- `getEvents(conversationId, sinceSeq?)` — ordered replay; reconstructs events through `parseEvent`
  (null columns dropped so the strict envelope accepts them).
- `searchMessages(query, {limit?, conversationId?})` — FTS5 `MATCH`, `ORDER BY rank` (bm25, lower =
  better), `snippet()` highlight; returns hits with text + snippet + rank.

## Spill (D9)

When a `tool.completed` result serializes to > `SPILL_THRESHOLD_BYTES` (32 KB), the store writes the
serialized result to `<spillDir>/<artifactId>.json`, inserts an `artifacts` row, and rewrites the
event payload to `{spilledArtifactId, preview (≤500 chars), isError}`. Small results stay inline and
create no artifact. This keeps the event log compact and replayable while preserving a pointer to the
full payload.

## Projection reducer (`project.ts`, ADR-0006)

`applyEventProjection(db, event)` runs inside `appendEvent`'s transaction and materializes read-model
rows. It is pure-except-SQLite, deterministic (timestamps come from `event.ts`), fails closed (a
constraint violation rolls back the event), and never writes a secret. Mapping:

| Event namespace | Table | Behaviour |
|---|---|---|
| `message.*` | `messages` (+FTS) | insert one row, `id == event.id`; `content_json` is the full payload |
| `task.created/updated/completed` | `tasks` | insert / patch mutable fields / `status='done'` |
| `decision.recorded/superseded` | `decisions` | **INSERT only** (`supersedes_id` on the new row); append-only triggers honored |
| `memory.updated/consolidated` | `memory_entries` | **upsert** from inline content (≤4000); `char_count` generated (ADR-0007) |
| `provider.connected/degraded/restored` | `accounts` | `connected` creates-or-marks the row; degraded/restored mark health; **never `secret_ref`** |
| `connector.installed/updated/removed` | `connectors` | insert / status patch / delete |
| `settings.updated` | `settings` | upsert; secret-ish keys already blocked by the event schema + CHECK |
| `lane.spawned/mandate/progress/merge_report/completed/aborted` | `lanes` | state machine; project/conversation from the envelope |
| everything else | — | log-only (no projection) |

## Public Store API (`store.ts`, ADR-0007)

**The daemon/kernel uses the Store API, never raw SQL.** Write APIs construct a validated protocol
event and call `appendEvent` (so every entity write is logged + projected atomically); read APIs return
mapped camelCase rows.

**Write APIs** (each returns the generated id where relevant + the sealed event): `createTask`,
`updateTask`, `completeTask`, `recordDecision`, `supersedeDecision`, `putMemoryEntry`,
`consolidateMemoryEntries`, `updateSetting`, `installConnector`, `updateConnector`, `removeConnector`,
`connectProviderAccount`, `markProviderDegraded`, `markProviderRestored`. All take an `EntityWriteOpts`
(`origin` default `system`, optional `turnId`/`laneId`/`channel`). Global-config writes
(settings/connectors/accounts) still carry a `conversationId` (the originating/system conversation).

**Read APIs:** `getConversationTree` (recursive `parent_id` walk), `listTasks`, `listDecisions`
(`includeSuperseded?`), `getDecisionHistory` (recursive `supersedes_id` chain), `searchMemory`
(FTS5, see below), `getSetting`, `listConnectors`/`getConnector`, `listAccounts`/`getAccountHealth`,
`getProviderConfigStatus`, `listLanes`. Plus the lower-level `appendEvent`, `recordUserMessage`,
`getEvents`, `searchMessages`.

### Secure config binding (DIRECT write — the one exception, ADR-0008)

`secret_ref` is **local secure configuration, not domain state**, so it is *not* event-sourced (that
would put the binding into the log). Three methods write `accounts.secret_ref` **directly** — the only
sanctioned direct domain-table write — and touch nothing else: `bindAccountSecretRef(accountId,
envName)`, `clearAccountSecretRef(accountId)`, `getAccountSecretRef(accountId)`. `envName` is validated
by `isSafeEnvSecretRefName` (UPPER_SNAKE_CASE, 3..64, ≥1 underscore); the value is never stored.
`getProviderConfigStatus(accountId)` reports `missing_secret_ref | secret_ref_bound | degraded |
healthy` without exposing a value.

### Memory full-text search (`memory_entries_fts`, migration `0002`, ADR-0008)

External-content FTS5 over `memory_entries.content`, synced by `memory_entries_ai/ad/au` triggers; the
migration's `up` runs a `'rebuild'` so existing rows are indexed (down→up re-indexes deterministically).
`searchMemory(query, {scope?, projectId?, limit?})` tokenizes the query to alphanumeric **prefix**
terms (implicit AND), returns `[]` for an all-punctuation query, and **orders by `bm25` (best first)**.

### Secret boundary

- **`accounts`:** events never set or carry `secret_ref`; only the secure binding API sets it, to an
  env-NAME (never a value), double-guarded by `isSafeEnvSecretRefName` + the table CHECK.
- **`settings`:** secret-ish keys (`secret`/`api_key`/`apikey`/`token`/`password`) are rejected by the
  event schema's `.refine` **and** the table CHECK — neither weakened.
- **`memory`:** content is the user's own data (bounded ≤4000) and is stored as written; it is *not*
  a credential surface and is not key-tripwired (ADR-0007). The API never copies a secret into it.
- **events:** an invariant test asserts no event payload schema defines a `secret`/`apiKey`/`token`/
  `password`/`keyValue` field.
