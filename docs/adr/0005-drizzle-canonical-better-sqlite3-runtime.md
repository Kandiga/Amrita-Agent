# ADR-0005: Drizzle schema canonical, better-sqlite3 runtime; FTS generated column

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#0 introduced two design choices as proposals (recorded informally under ADR-0001
  D3). The WO#0 self-review asked for them to be explicitly ratified before further store work. This
  ADR does that.

## Decision 1 — Two artifacts, one schema, clear roles

- **`packages/store/src/schema.ts` (Drizzle) is the canonical *table declaration*** — the typed
  shape of every table, used for typed reads and (later) drizzle-kit generation.
- **The hand-written SQL migration is the source of truth for *applied state and constraints*** that
  Drizzle cannot express: triggers (FTS sync, append-only enforcement, parent-id integrity),
  `GENERATED ... VIRTUAL` columns, and `CHECK` predicates with `GLOB`/`substr`.
- **`packages/store/src/store.ts` drives better-sqlite3 directly** for the imperative paths
  (in-transaction `seq` assignment, FTS triggers, spill side-effect) where an ORM query builder
  obscures the transaction boundary.

**Invariant:** the Drizzle schema and the SQL migration must stay in lock-step. When they diverge,
the SQL migration wins at runtime; the divergence is a bug to be fixed by an ADR + migration, never
by silently editing a shipped migration.

*Alternatives rejected:* (a) Drizzle query-builder at runtime — hides where `seq` is assigned and
can't express the FTS/trigger machinery; (b) raw SQL only, no Drizzle — loses typed reads and
generation. The split keeps the strengths of both.

## Decision 2 — FTS5 external content via a generated column

`messages.content` is a `GENERATED ALWAYS AS (json_extract(content_json,'$.text')) VIRTUAL` column;
`messages_fts` is an external-content FTS5 table with `content='messages', content_rowid='rowid'`,
kept in sync by `messages_ai/ad/au` triggers. **Ratified as the standing approach.**

*Why:* `content_json` stays the single source of the message body, the FTS column name is literally
`content` (matching `messages_fts(content, …)`), and an FTS `rebuild` works because the generated
column is a real, readable column. *Alternative rejected:* a duplicated plain `text` column kept in
sync by hand — redundant and drift-prone.

## Decision 3 — No new runtime dependencies in this work order

WO#1.1 adds **zero** dependencies. It uses only `better-sqlite3`, `drizzle-orm`, and
`@amrita/protocol`, already approved in WO#0. (`@types/better-sqlite3` is a pre-existing dev dep.)
The hard boundary "no dependencies without an ADR" is satisfied vacuously: nothing was added.

## Consequences

Reviewers reading `schema.ts` get the table shapes; reviewers needing the exact applied constraints
read the migration. Both are committed; neither is generated from the other yet (drizzle-kit
generation is deferred to a later phase, behind its own ADR).
