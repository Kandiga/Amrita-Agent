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
- **conversations** `(id, project_id→projects, title?, created_at, updated_at, archived_at?)`
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

## Migrations (`migrate.ts`)

- `MIGRATIONS` is an ordered, append-only list. Never edit a shipped migration; add the next one.
- `migrateUp(db)` applies every unrecorded migration in a transaction, recording its version.
- `migrateDown(db, toVersion?)` reverts highest-first using the paired `.down.sql`.
- `currentVersion(db)` reports the highest applied version (or -1).
- **Acceptance:** up → down → up leaves an identical schema and an idempotent second `up` applies 0.

## The store API (`store.ts`)

- `openStore({path, spillDir?})` — opens SQLite, sets `journal_mode=WAL`, `foreign_keys=ON`,
  `busy_timeout`, and runs `migrateUp`.
- `appendEvent(unsealed)` — validates (`parseUnsealedEvent`), rejects stream-only types, then in one
  transaction: assigns `seq = COALESCE(MAX(seq),0)+1` for the conversation, spills an oversized tool
  result, inserts the row, touches `conversations.updated_at`, and returns the sealed `AmritaEvent`.
- `recordUserMessage({projectId, conversationId, text, turnId?, channel?})` — the **hybrid model**:
  writes a `messages` row *and* a `message.user` event in the same transaction, so a reader can never
  see one without the other.
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
