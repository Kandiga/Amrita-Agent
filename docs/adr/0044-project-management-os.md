# ADR-0044: The Project-Management OS — the agent↔domain bridge, the Inbox, the board, the hub

- **Status:** Accepted
- **Date:** 2026-07-14
- **Supersedes-scope:** completes the intake/extraction phase **explicitly deferred** by
  ADR-0018 ("Intentionally deferred: *Conversational intake/extraction* — an agent turn that
  proposes brief/questions from chat … the extraction itself is a later phase and must be
  labeled as a proposal, never auto-committed"). This is that later phase.
- **Research:** the plan at `docs/progress/amrita-v2-upgrade-ledger.md` (phase H entry) and the
  session research packet.

## Context — the root cause, stated plainly

Amrita is described everywhere as a *chat-first, project-aware agent OS*. At the chat layer she
is neither project-aware nor able to affect project state:

- **She cannot read the project.** The provider call passes **only the conversation transcript**
  (`packages/daemon/src/kernel.ts:1229-1231`). `ChatRequest` is `{ messages, model }`
  (`packages/daemon/src/provider.ts:28-31`) — there is **no system-prompt field**. No brief, no
  tasks, no risks, no decisions, no memory, no Brain, no git context ever reaches the model.
- **She cannot write the project.** `ChatProvider` has **no tool surface**, and the daemon has
  **no tool-dispatch path**. The `tool.*` event taxonomy (`packages/protocol/src/events.ts:171-179`)
  is dead code. ADR-0043 already ships this as an honest product label ("chat = **no tools**,
  structural").

The result is measurable. The live DB holds **7 projects, 25 conversations, 298 events** — and
**0 tasks, 0 milestones, 0 risks, 0 open questions**. No `task.*` / `milestone.*` / `risk.*` /
`question.*` event has *ever* been emitted. The typed write path built by ADR-0018 works; the only
thing that would have exercised it — the agent — was never connected to it.

The same severed link appears at **every** point where an agent could produce project truth:

| Path | Produces | Where it dies |
|---|---|---|
| Chat turn | text only | no tools, no system prompt |
| **Lane merge report** | typed `tasks[]`, `decisions[]`, `followUps[]` (`protocol/lane.ts:88`) | `store/project.ts:489-495` writes `merge_json` **and nothing else** — the arrays are discarded |
| `tasks.create` | — | silently drops `laneId`, though column + event + store all support it |
| `store.updateTask` | `task.updated` | **no kernel method, no RPC — unreachable** |
| `projects.milestones.update` | `milestone.updated` | daemon exposes it; **no web client wrapper** |
| `projects.root` | — | **write-once**: set only in `createProject`; no `updateProject` exists → all 7 live roots are `NULL` |

The pattern is consistent: *the write path gets built and tested, then nothing is wired to call
it.* This ADR wires them.

## Decision

### 1. Context in — the Project Context Pack (no schema change)

A new **pure** daemon module `context-pack.ts` assembles a bounded, deterministic, secret-free
digest of live project state (charter, open questions, open risks, active milestone, tasks in
flight, recent decisions, knowledge gaps, **honest connector status**) and passes it via a new
optional `ChatRequest.system` field. Adapters map it to the Anthropic `system` param, an OpenAI
system message, or the CLI `--append-system-prompt`; a provider that cannot take one prepends a
`system` message. No fake capability.

**Invalidation: none.** The pack is assembled **fresh from the store at every turn**, so any
committed event is visible to the next turn by construction. There is no cache, and therefore no
cache-invalidation bug class. This is what makes "the board updates Amrita's context without a
second chat message" true *for free*.

Naming: the lane mandate already owns `contextPackSchema` (`protocol/lane.ts:31`). The chat pack
is a **different** thing and is named `ProjectContextPack` / `buildProjectContextPack` so the two
never blur.

### 2. Proposals out — the Scribe, and ONE Inbox

A post-turn **Scribe** pass (daemon `scribe.ts`), routed to the `fast` provider role, reads the
exchange plus the same context pack and emits **typed proposals** parsed against a strict Zod
schema. A malformed proposal is **dropped, never guessed at**. The Scribe runs **off the reply
path** and can never add latency to, or corrupt, the user's turn.

Proposals land in **one new aggregate — `inbox_items`** — alongside human quick-capture and lane
merge-report outputs. **One Inbox, four origins** (`user | agent | lane | system`). Triage
promotes an item into an existing aggregate by calling the **existing typed command**, then
records the promotion.

#### The auto-commit boundary (product-owner decision)

| Proposal kind | Path |
|---|---|
| **`question.opened`** | **auto-commits** |
| `task` · `risk` · `decision` · `milestone` · `memory` | **always Inbox → human triage** |

An open question is the only companion item that is *inert*: it asserts nothing, changes no plan,
and its entire semantic is "this is unresolved". It is also the most reversible (`question.dropped`
requires a reason). Everything that **asserts** something — a task someone must do, a risk that
shapes the plan, a decision of record — still passes a human. Guards, all tested: **≤3 auto-opened
questions per turn**, dedup against existing `open` questions, mandatory `sourceMessageId`
provenance, "opened by Amrita" attribution in the UI, a test asserting the Scribe emits
**`question.opened` and no other domain event**, and a kill-switch
(`settings['scribe.autoOpenQuestions']`).

This honors ADR-0018's constraint where it matters and relaxes it only where the item cannot
create silent wrong project truth.

### 3. Activate what already exists

- **`tasks.update`** — wire the dormant, tested `store.updateTask` (`store.ts:726-753`) through
  kernel → RPC → web client. This alone unlocks re-staging, retitling, and milestone
  re-assignment: **the kanban write path already exists and is merely unreachable.**
- **`project.setRoot`** — a new store method + RPC, because `root` is currently write-once and
  therefore unreachable (the reason every live project has `root = NULL`). Validated against the
  existing allowed-roots allowlist at the **write**, the only place it can be enforced once.
- **`tasks.create`** — thread the dropped `laneId`.
- **Lane merge-back** — project `lane.merge_report`'s typed `tasks[]` / `decisions[]` /
  `followUps[]` into the Inbox as `origin: 'lane'` proposals instead of discarding them.
- **`projects.milestones.update`** — add the missing web client wrapper.

### 4. Entities

**Migration `0009_events_project_index`** — a bug fix, no new state.
`0004_companion.sql:139` created `idx_events_project_ts`. `0007_whatsapp_channel.sql:24-28`
rebuilt the `events` table and recreated only two of the three indexes — its own comment claims
"both indexes are preserved", which was already wrong. **`idx_events_project_ts` has been missing
ever since**, so `listProjectEvents` (`store.ts:634-640`, `WHERE project_id = ? ORDER BY ts DESC`)
— the query behind the timeline, the weekly review, the hub and the retro — is a **full table
scan**. Restored here.

**Migration `0010_inbox`** — `inbox_items`: `id`, `project_id` (CASCADE), `conversation_id`,
`source_message_id`, `origin ∈ {user,agent,lane,system}`, `text`, `suggested_kind ∈
{task,decision,risk,question,milestone,memory}?`, `suggested_json?`, `rationale?`, `confidence ∈
{low,medium,high}?`, `status ∈ {pending,triaged,dismissed}`, `promoted_kind?`, `promoted_id?`,
`dismiss_reason?`, timestamps. Two CHECK invariants in the ADR-0018 house style — **no silent
closure**:
- `triaged` ⇒ `promoted_kind` **and** `promoted_id` are present (a promotion must name what it
  became);
- `dismissed` ⇒ a `dismiss_reason`.

**Migration `0011_charter`** — `project_briefs` gains `finish_line`, `constraints_json`,
`decision_rights_json`. The brief is a **full-document upsert** (ADR-0018), so extending it is
natural and replay-safe.

**Migration `0012_task_board`** — `tasks` gains `owner` (free text — Amrita has **no user table**,
and inventing one is a separate, much larger decision), `due_date` (GLOB-checked), `priority ∈
{low,normal,high}`, `order_key` (a lexicographic fractional index, so a drag is **one**
`task.updated` with no sibling re-indexing), `blocked_reason`, plus `idx_tasks_board`.

**`taskStatusSchema` is deliberately NOT widened.** It stays `now | later | done | dropped`.
SQLite cannot alter a CHECK without a full table rebuild — which is exactly what `0007` did, **and
it lost an index in the process**. "Waiting/Blocked" is therefore a nullable `blocked_reason`
column, expressing the same board column at zero migration risk.

**Migration `0013_publications`** — `project_publications`: `project_id` PK, `public_slug`
UNIQUE, `content_hash`, `published_at`, `revoked_at`.

### 5. Events (protocol additions, ADR-0004 taxonomy)

| Event | Payload |
|---|---|
| `inbox.captured` | `{itemId, projectId, origin, text, suggestedKind?, suggested?, rationale?, confidence?, conversationId?, sourceMessageId?}` |
| `inbox.triaged` | `{itemId, promotedKind, promotedId}` |
| `inbox.dismissed` | `{itemId, reason}` |
| `publication.published` | `{projectId, publicSlug, contentHash}` |
| `publication.revoked` | `{projectId, reason}` |

Plus **additive-optional** extensions, so all 298 historical events replay byte-identically (the
house convention, guarded by `protocol.test.ts:454`):
- `brief.updated` **+** `finishLine?`, `constraints?`, `decisionRights?`
- `task.created` / `task.updated` **+** `owner?`, `dueDate?`, `priority?`, `orderKey?`,
  `blockedReason?` (nullable on update, to clear)

### 6. Views are projections — and now it is *proven*

`Store.rebuildProjections()` replays the entire event log, in original append order (`rowid`), into
the event-derived read model, inside **one transaction** (any failure rolls the whole thing back).
This is the executable fitness function for the "views are projections" invariant, and the
prerequisite for any future projection.

**Honest scope.** Only tables whose *sole* writer is `applyEventProjection` are rebuilt:
`messages`, `tasks`, `decisions`, `open_questions`, `risks`, `milestones`, `project_briefs`,
`project_brands`, `preview_approvals`, `memory_entries`, `lanes`, `connectors`, `inbox_items`,
`project_publications`, and `conversations.archived_at`. **Not** rebuilt, because they have
sanctioned non-event writers (ADR-0007/0008/0013): `projects` and `conversations` themselves
(created by direct insert — `project.created`/`conversation.created` exist in the taxonomy but the
reducer has **no case** for them), `accounts.secret_ref`, `settings`, `channel_pairings`, and
`artifacts` (written by the spill path, not the reducer).

Clearing `decisions` requires the **append-only** trigger's gate. The rebuild reuses the existing,
sanctioned per-project `settings['cascade.project.delete']` mechanism from ADR-0038 exactly as
designed — opened per project, cleared before commit, never observable outside the transaction. It
does **not** weaken the trigger.

### 6b. Project-scoped live push (a third WS frame)

The board is worthless if a drag in one browser does not reach the other. Today the WS fan-out is
filtered on a **single `conversationId`** (`http.ts`), and the web client's `onEvent` handles only
transcript / lane / approval events — so **no domain event reaches any client**, and a change made
from the CLI, Telegram or a second tab is invisible until a manual reload.

`WS /events/ws` therefore gains an **optional `projectId`** and the frame union gains a third
member:

```
{ t: 'project-event', event: <sealed event shell> }
```

**It deliberately carries no cursor.** `seq` is per-conversation (`nextSeq`), so a project-wide
stream has **no single monotonic sequence** to resume from — inventing a global one would be a real
schema change with real ordering hazards. Instead:

- `t: 'event'` keeps its exact `seq > lastSeq` cursor semantics for the open conversation. Untouched.
- `t: 'project-event'` is a **notification, not a log**: it says "this project's state changed",
  and the client **refetches the affected projection**. Missing one is harmless (the next one, or a
  reconnect, re-syncs); replaying one is harmless (a refetch is idempotent).
- On reconnect the client refetches project state wholesale. Cheap, and correct by construction.

Which events qualify is owned **once**, in the protocol (`PROJECT_DOMAIN_EVENT_TYPES`), and imported
by both the daemon and the web client — never re-declared in a caller.

This keeps the ADR-0016 delta bus intact: `model.delta` is still stream-only with `seq: 0`, still
never persisted, and still forwarded only to the conversation that owns it.

### 7. The public stakeholder hub — the private/public hard boundary

The public projection is a **field allowlist in code**, not a redaction pass and **never** a model
instruction. `buildPublicHub()` *constructs* the public object from named fields; a field that is
not named **cannot appear**, whatever any model says. A test asserts the rendered key set is
**exactly** the allowlist, so adding a field to the brief cannot widen the hub without editing the
allowlist *and* the test.

Publication reuses ADR-0020 wholesale: a deterministic render, an FNV-1a content hash, and a
durable approval — so a state change **auto-demotes an approved hub back to `proposed`**, and an
approval can never cover content the operator did not see. Publishing calls `requestApproval`,
which today has **exactly one caller** (real lane runs); it gains its second.

**Serving (product-owner decision).** `GET /p/:slug` is a public route **on the daemon**, joining
`/health` and the lane-workspace ticket as an auth-gate exception. The auth gate deliberately runs
*before* route matching (`http.ts:150`), so this is the first hole ever punched in it, and it is
gated accordingly:

- **the request path executes ZERO SQL** — it serves pre-rendered bytes from a fixed directory;
  publication state is resolved at *publish* time, not at *serve* time. This removes the entire
  injection/query class;
- slug `^[A-Za-z0-9_-]{16,64}$`, validated **before** any path is constructed — opaque,
  high-entropy, not enumerable, unrelated to the ULID;
- `realpath` jail + symlink-escape → 403 (the existing `http.ts:273-283` lane-workspace pattern);
- the hostile lane-workspace CSP (`sandbox allow-scripts; connect-src 'none'; form-action 'none'`)
  — a published page cannot call back into the daemon;
- **no directory listing** (a missing `index.html` 404s — unlike the lane workspace);
- per-IP rate limit; revocation deletes the bytes.

**Accepted residual risk, recorded:** the process answering public requests holds the SQLite handle
open, so a daemon RCE reaches the whole database rather than only the published bytes. The
alternative (rendering to disk and serving from `deploy/serve-web.mjs`, which holds **no** DB
handle and no secret) was recommended and **not** chosen. Slice 8 gets a dedicated security review.

### 8. Scheduler — the weekly review

Two defects block a weekly job and are fixed here:
1. `intervalMinutes.max(24 * 60)` (`scheduler.ts:31`) — **weekly is inexpressible.** Widened to
   `7 * 24 * 60`.
2. `lastRunAt` is an **in-memory Map** (`scheduler.ts:73`) — **a restart makes every job
   immediately due**, so a weekly review would re-fire a packet on every restart. Run-state is
   persisted in `settings` (the existing settings-backed pattern).

Belt-and-braces: the packet is keyed `review:<projectId>:<ISO-week>` and a second run in the same
week **updates** rather than duplicates.

The job produces **proposals** (stale items, at-risk milestones, blockers, unanswered questions,
public-safe update candidates) as Inbox items plus one `message.system`. **Invariant, tested: the
review job may emit only `inbox.*` and `message.system`.** It never publishes, never changes scope,
never closes a task.

## Consequences

Amrita becomes what she is described as: a companion who knows the project and can propose changes
to it, whose every proposal is auditable and whose consequential proposals are gated. The board,
the weekly review, the stakeholder hub and the retrospective are then **projections and jobs over
that loop**, not new subsystems.

New persisted state is deliberately small: **one real new aggregate (`inbox_items`)**, one small
publication table, five additive task columns, three additive brief columns. No parallel store, no
Markdown database, no second app. The reducer stays pure and clock-free; every new payload field is
additive-optional; every new table is added to `deleteProject`'s cascade list (`store.ts:379`) and
to `REQUIRED_TABLES` (`store.test.ts:27`).

## Intentionally deferred

- **Native provider tool-calling.** The Scribe feeds the *same* typed proposal schema, so tool-use
  can later become a faster path to an identical result. Two of four runtimes are subprocesses;
  building tool-use into all of them before anything works would delay the keystone.
- **A user/contact model.** `owner` is free text until accounts/permissions/identity are designed.
- Task dependencies and critical path; Gantt; templates; email/calendar/chat ingestion connectors
  (which stay honestly `planned` until they truly exist).
