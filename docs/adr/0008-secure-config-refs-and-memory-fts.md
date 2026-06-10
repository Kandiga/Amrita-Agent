# ADR-0008: Secure secret-ref binding + memory FTS

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#1.4 left two items: accounts are created via events with `secret_ref = NULL` (binding
  a secret reference needs a path that keeps secrets out of the log), and `searchMemory` was a `LIKE`
  fallback pending an FTS index. WO#1.5 closes both.

## Decision 1 — `secret_ref` is an env-var NAME, never a value

`accounts.secret_ref` holds the **name** of an environment variable that holds the secret (e.g.
`ANTHROPIC_API_KEY`), never the secret itself. Secret values never enter the database, the event log,
or any payload. A safe name is gated by `isSafeEnvSecretRefName` (`@amrita/protocol`):
UPPER_SNAKE_CASE, 3..64 chars, **with at least one underscore** — the underscore requirement rejects
secret *values* that happen to be all-caps alphanumeric (e.g. cloud access-key ids). The
`accounts.secret_ref` SQL CHECK (ADR-0003) is the last line of defence.

## Decision 2 — Secure config binding is a sanctioned DIRECT write (the one exception)

Binding a `secret_ref` is **local secure configuration, not event-sourced domain state**, so it must
not be a `provider.*` event (those would put the binding — and tempt a value — into the log). The
Store therefore exposes three methods that write `accounts.secret_ref` **directly**:

- `bindAccountSecretRef(accountId, envName)` — validates the name, sets `secret_ref` (+`updated_at`).
- `clearAccountSecretRef(accountId)` — sets `secret_ref = NULL`.
- `getAccountSecretRef(accountId)` — returns the bound NAME (never a value), or `null`.

**This is the only sanctioned direct write to a domain table.** It touches `secret_ref` and nothing
else; all other entity state still flows through `appendEvent` + the reducer. We deliberately do *not*
emit an audit event for the binding (it would need an envelope `conversationId`/`projectId` a global
config action lacks, and risks coupling secret config to a conversation) — keeping the boundary simple
is the priority. Provider readiness is exposed without secrets via
`getProviderConfigStatus(accountId)` → `missing_secret_ref | secret_ref_bound | degraded | healthy`,
and `listAccounts()`'s `secretRef` (a NAME) signals "configured" without a value.

## Decision 3 — Memory full-text search (migration `0002`)

`memory_entries_fts` is an external-content FTS5 table over `memory_entries.content` (a real column,
≤4000), kept in sync by `memory_entries_ai/ad/au` triggers — mirroring `messages_fts`. The migration's
`up` runs `INSERT INTO memory_entries_fts(memory_entries_fts) VALUES('rebuild')` so existing rows are
indexed (and so a down→up re-indexes deterministically). The FTS table and triggers are **SQL-only**;
Drizzle cannot express them (noted in `schema.ts`).

**Search semantics (`searchMemory`):** the query is lowercased and tokenized to alphanumeric terms,
each matched as a **prefix** (`term*`, implicit AND), so partial words match; an all-punctuation query
returns `[]`. **Ranking/order:** results are ordered by `bm25(memory_entries_fts)` — best match first.
Optional `scope`/`projectId` filters narrow the joined `memory_entries` rows. The `LIKE` fallback is
removed (FTS is always present after `0002`).

## Consequences

The daemon can read provider readiness and rank memory without raw SQL or secret exposure. The only
new "secret surface" is the local secret-ref binding, which is value-free by construction and
double-guarded (JS validator + DB CHECK). Deferred: actually *reading* a secret value from the
environment at provider-call time (a narrow presence/lookup helper) belongs to the provider-runtime
WO, not here.
