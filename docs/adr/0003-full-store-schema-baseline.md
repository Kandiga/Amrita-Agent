# ADR-0003: Full store schema baseline (Phase 0 completion)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#0 shipped the event-sourcing spine (`projects`, `conversations`, `messages` +
  FTS, `events`, `artifacts`, `schema_migrations`) but not the full entity baseline required by the
  approved v1.0 plan §3.3. The WO#0 self-review flagged this; WO#1.1 closes it. This ADR defines
  migration `0001_full_store_schema` and its invariants.

## Decision

Add, in one reversible migration:

### `conversations.parent_id` — lineage
- Nullable TEXT column + `idx_conversations_parent`, self-referencing `conversations.id`.
- **Integrity via triggers, not a `REFERENCES` clause.** SQLite's `ALTER TABLE DROP COLUMN` cannot
  remove a column that participates in a foreign-key constraint, which would make the migration
  irreversible without a full table rebuild (and a rebuild under `foreign_keys=ON` inside the
  migration transaction risks cascade deletes). `BEFORE INSERT` / `BEFORE UPDATE OF parent_id`
  triggers enforce: the parent must exist, and a conversation cannot be its own parent.
  Deep-cycle prevention (A→B→A) is an application-layer concern (the store never re-parents today).

### `tasks`
`id, project_id (FK→projects CASCADE), conversation_id (FK→conversations SET NULL),
source_message_id (FK→messages SET NULL), lane_id, status, title, body?, created_at, updated_at`.
- `status ∈ {now, later, done, dropped}` (CHECK) — v0.1's TASKS.md vocabulary plus an explicit
  terminal "dropped" so deletion is never needed for bookkeeping.
- Index `(project_id, status)` for the "what's on now" query.

### `decisions` — append-only
`id, project_id (FK→projects, NO ACTION), conversation_id?, source_message_id?, supersedes_id
(FK→decisions), text, created_at`.
- **Append-only is enforced by `BEFORE UPDATE` / `BEFORE DELETE` triggers** that `RAISE(ABORT)`.
  Corrections happen by inserting a superseding row pointing at `supersedes_id`.
- Because rows are immutable, `conversation_id` / `source_message_id` are **plain provenance
  pointers without FK actions** — a deleted conversation may leave a dangling pointer, which is
  acceptable for an immutable log (the alternative, `SET NULL`, is an UPDATE and would fight the
  append-only triggers). `project_id` keeps a NO-ACTION FK: you cannot delete a project that has
  decisions.

### `memory_entries`
`id, scope ∈ {user, project}, project_id?, content, char_count (generated = length(content)),
source?, source_message_id?, created_at, updated_at`.
- CHECKs: `scope='project' ⇒ project_id NOT NULL`; `scope='user' ⇒ project_id IS NULL`;
  `length(content) ≤ 4000` (the per-entry char budget — context-pack assembly sums `char_count`).
- Index `(scope, project_id)`.

### `lanes`
`id, project_id (FK CASCADE), conversation_id (FK CASCADE), kind, status, mandate_json,
budget_json?, merge_json?, created_at, updated_at`.
- `status ∈ {spawned, running, merging, completed, aborted}` (CHECK). The JSON columns hold
  protocol-validated `LaneMandate` / `MergeReport` documents; the store parses them through
  `@amrita/protocol` at the API layer (WO#1.3+), the DB stores the sealed JSON.

### `accounts` — **no secrets, ever**
`id, provider, label?, auth_mode ∈ {api_key, subscription_cli, local_endpoint, oauth},
secret_ref?, metadata_json?, created_at, updated_at, UNIQUE(provider, label)`.
- `secret_ref` is a **name** in the secrets file (v0.1's `~/.amrita/secrets.env` model), never a
  value. A CHECK enforces the env-name shape (`^[A-Z][A-Z0-9_]*$`, harvested from v0.1's
  `ENV_NAME_RE`) via `secret_ref NOT GLOB '*[^A-Z0-9_]*' AND substr(secret_ref,1,1) GLOB '[A-Z]'`:
  anything secret-*shaped* (lowercase, dashes, `sk-…`) is rejected at the schema, not just in code.

### `connectors` — no secrets
`id, slug UNIQUE, kind, status ∈ {needs_setup, ready, error, disabled}, manifest_json?,
config_json?, created_at, updated_at`. Connector credentials, where they exist, live behind
`accounts.secret_ref` — never in `config_json` (API-layer rule; schema keeps the columns non-secret
by convention + review).

### `settings` — non-secret config values
`key PRIMARY KEY, value_json, updated_at`.
- A CHECK rejects keys containing `secret`, `api_key`, `apikey`, `token`, or `password` — a
  schema-level tripwire against the "stuff a credential into settings" failure mode. Secrets belong
  in the secrets file, referenced by `accounts.secret_ref`.

## Reversibility

`0001_full_store_schema.down.sql` drops the triggers, indexes, and tables, then
`ALTER TABLE conversations DROP COLUMN parent_id` (legal: plain nullable column, its index and
triggers dropped first, no FK clause — see lineage rationale above). Tested up → down → up, and a
targeted down to version 0 (reverts only 0001, leaving the spine intact).

## Consequences

- The protocol's `conversationRowSchema` does **not** yet expose `parentId`, and there are no
  `task.*` / `decision.*` event types — those are protocol changes and land in WO#1.2 under a new
  ADR-0004 (per the CLAUDE.md "protocol changes only via an ADR" rule). Until then the new tables
  are reachable only via SQL; no store read/write API is added in this work order.
- The generalized "entity write ⇒ event in the same transaction" reducer is WO#1.3; this ADR only
  lays the tables it will project into.
