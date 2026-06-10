# Amrita — Architecture & Build Plan v1.0

> The greenfield v2 of Amrita: a chat-first, project-aware, multi-channel agent OS, rebuilt as a
> typed pnpm monorepo whose foundation is a Zod **event protocol** and an event-sourced **store**.
> v0.1 (single package, zero runtime deps) is frozen at tag `v0.1` and is a *reference*, not a
> source. See [`v01-harvest.md`](v01-harvest.md).

## 0. Identity (unchanged from v0.1)

- **Conversation is the interface.** One chat pane; a sidebar of projects and sessions.
- **Projects are the unit of memory.** Opening a project talks to an Amrita that knows its brief,
  decisions, tasks, history, and git state.
- **Connectors, not shells.** Claude Code (and later Codex/Gemini/Open Design) are optional lanes
  that open beside the chat and keep working if you close them.
- **Honest integrations.** Only official auth paths. Unconfigured shows "needs setup"; nothing is
  ever faked. No OAuth-token harvesting, ever.

What changes in v2 is *how the contracts are enforced*: one Zod protocol every boundary speaks, and
an event-sourced store that can replay a conversation deterministically.

## 1. Headline decisions (D1–D10)

See [`adr/0001-headline-decisions.md`](adr/0001-headline-decisions.md) for the full record.

| #  | Decision |
|----|----------|
| D1 | **pnpm workspaces monorepo.** Packages: `protocol`, `store`, then `daemon`, `providers`, `channels`, `web`, `lanes/*`. |
| D2 | **Zod is the constitution.** Every event, RPC frame, and persisted row is a Zod schema in `@amrita/protocol`. Nothing crosses a boundary unparsed. |
| D3 | **Event-sourced store.** Append-only `events` log is the source of truth; projects/conversations/messages are materialized read models. Drizzle schema + better-sqlite3 driver, WAL, FTS5. |
| D4 | **Per-conversation monotonic `seq`.** Assigned by the store inside the append transaction; total order within a conversation; `UNIQUE(conversation_id, seq)`. |
| D5 | **Role-based providers.** `fast` / `main` / `deep` roles map to concrete provider+model; `auto` resolves at runtime (carried from v0.1). |
| D6 | **Hono + ws daemon.** One localhost daemon; HTTP for control, a WebSocket for the live event stream; the RPC union (`@amrita/protocol`) is the only wire vocabulary. |
| D7 | **Lanes are mandate→report.** A lane gets a `LaneMandate` (goal, context pack, scope, budget, approval policy) and returns a `MergeReport`. Hard schema boundary. |
| D8 | **`model.delta` is stream-only.** Token deltas are emitted on the wire and never persisted; the store rejects them. Persist `model.response` instead. |
| D9 | **Spill big tool payloads.** A tool result over 32 KB is written to an artifact file; the event keeps `{spilledArtifactId, preview}`. Keeps the log small and replayable. |
| D10 | **ULIDs everywhere.** Sortable, URL-safe domain ids; integer rowids stay inside SQLite. |

## 2. Package map

```
packages/
  protocol/   ids, events (envelope + ~40 payloads), lane (mandate/report), rpc, entities  ← Phase 0
  store/      migrations, drizzle schema, migrate, event store (seq/hybrid/FTS/spill)        ← Phase 0
  providers/  role policy, provider catalog, `auto` resolver, Claude Code login probe        ← Phase 1
  daemon/     Hono control API + ws event stream, turn loop, approvals                       ← Phase 2
  channels/   web client transport, telegram (grammY), cli                                   ← Phase 3
  web/        React 18 + Vite + Tailwind chat UI, lanes panel                                ← Phase 4
  lanes/*     per-lane runners (claude-code first)                                           ← Phase 5
```

## 3. Specs

### 3.1 Envelope

Every event shares the envelope: `id` (ULID), `seq` (per-conversation, store-assigned), `ts`
(ISO-8601), `projectId`, `conversationId`, optional `turnId` / `laneId`, `origin`
(`user|agent|lane|system`), optional `channel` (`web|telegram|cli|api`). The envelope schema is
`.strict()` — an unknown field is a parse error, not silent data.

### 3.2 Event types

~40 namespaced types across: `conversation.*`, `message.*`, `turn.*`, `model.*`, `tool.*`,
`lane.*`, `approval.*`, `memory.*`, `artifact.*`, `project.*`, `channel.*`, `error.*`, `audit.*`.
The canonical list is the `eventPayloads` map in `@amrita/protocol`. `model.delta` is the only
stream-only type. Full detail: [`specs/event-protocol.md`](specs/event-protocol.md).

### 3.3 Store

The Phase-0 store schema has two layers, both delivered as hand-written reversible migrations.

**Spine (event sourcing) — migration `0000_init`:** `projects`, `conversations`, `messages`
(+ FTS5 external-content `messages_fts`), `events` (`UNIQUE(conversation_id, seq)`), `artifacts`,
`schema_migrations`. The store assigns `seq`, runs the hybrid user-message transaction (message row
+ event together), ranks search with bm25, and spills >32 KB tool results.

**Entity baseline — migration `0001_full_store_schema`** (see [ADR-0003](adr/0003-full-store-schema-baseline.md)):

- `conversations.parent_id` — **lineage** self-reference (trigger-enforced integrity, no FK clause).
- `tasks` — project work items with provenance (`project_id`, `conversation_id?`,
  `source_message_id?`, `lane_id?`), `status ∈ {now, later, done, dropped}`.
- `decisions` — **append-only** log (UPDATE/DELETE blocked by triggers), with `supersedes_id` and
  `source_message_id?` provenance.
- `memory_entries` — `scope ∈ {user, project}`, per-entry char budget (generated `char_count`),
  source/provenance fields.
- `lanes` — `mandate_json` / `budget_json` / `merge_json` + `status` lifecycle.
- `accounts` — provider/account metadata + **`secret_ref` only** (an ENV-NAME; never a secret value).
- `connectors` — manifest/status/config metadata, no secrets.
- `settings` — non-secret config values (a CHECK rejects secret-ish keys).

Constraints that protect the plan's invariants (append-only decisions, scope/budget on memory,
`secret_ref` env-name shape, secret-key tripwire on settings, lineage integrity) live in the SQL
migration; the Drizzle `schema.ts` mirrors the table shapes ([ADR-0005](adr/0005-drizzle-canonical-better-sqlite3-runtime.md)).
Full detail: [`specs/store.md`](specs/store.md).

## 4. Phasing & acceptance

- **Phase 0 — foundation.** `@amrita/protocol` + `@amrita/store`, fully typed and tested.
  WO#0 delivered the protocol + store spine; **WO#1.1 completes the §3.3 entity baseline** (the
  `0001` migration above). **Acceptance:** Zod round-trip of a sealed event; FTS returns ranked
  hits; migrations go up→down→up (across both migrations, plus a targeted down); `seq` is monotonic
  per conversation; stream-only events are rejected; >32 KB tool result spills; all §3.3 tables
  exist; the entity invariants hold (append-only decisions, memory scope/budget, `secret_ref` shape,
  settings tripwire, lineage integrity).
- **Phase 1 — providers.** Role policy (`fast/main/deep`), provider catalog, `auto` resolver, and
  the Claude Code local-login probe (`claude auth status --json`) ported from v0.1 as a
  `subscription_cli` auth mode. **Acceptance:** `auto` resolves to a healthy provider; doctor-style
  health is unit-tested with a stub CLI.
- **Phase 2 — daemon.** Hono control API + ws stream; the turn loop appends events; approvals
  round-trip over RPC. **Acceptance:** a client subscribes, sends `message.send`, and receives the
  resulting event stream replayed from `sinceSeq`.
- **Phase 3 — channels.** Web transport + Telegram (grammY) with an owner-only allowlist (ported)
  plus pairing codes. **Acceptance:** Telegram deny-by-default is unit-tested; a paired owner can
  switch project context.
- **Phase 4 — web.** React chat UI, lanes panel, magic-link login. **Acceptance:** streaming render
  of `model.delta`; RTL-aware.
- **Phase 5 — lanes.** Claude Code lane runner consuming a `LaneMandate`, emitting `lane.progress`
  and a final `MergeReport`. **Acceptance:** a mandate with a budget aborts at the budget and
  returns `exit: 'budget'`.

## 5. Cross-cutting specs (detail referenced by later phases)

- **§5.4 Doctor.** Grouped checks (`◆` sections), warn-vs-fail scoping (unconfigured `auto` is a
  warning, an explicitly-chosen keyless API provider is a failure), and a numbered "run this exact
  command" footer. Ported from v0.1; see harvest doc.
- **§6.4 Telegram.** Deny-by-default numeric allowlist; gates messages *and* callback queries; logs
  dropped ids; chunked sends. v2 adds pairing codes on top.
- **§7 Security.** (5) path jail — resolve + `base+sep` boundary + absolute-path rejection +
  `realpathSync` symlink defense. (6) env scrubbing for delegated subprocesses — allowlist only,
  never forward unrelated secrets (notably never `ANTHROPIC_API_KEY` into a Claude Code lane, so it
  uses the subscription login). Ported with their regression tests.

## 6. Non-goals (v2.0)

Multi-user/tenancy, vector retrieval, MCP client, and packaged auto-update are explicitly out of
the first v2 release; the event log and provider seams are designed so they can be added without a
schema break (each via an ADR).
