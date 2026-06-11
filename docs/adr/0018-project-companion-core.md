# ADR-0018: Project Companion Core (brief, questions, risks, milestones, timeline)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** The companion roadmap (docs/strategy/project-companion-roadmap.md) recommends
  "Project Companion Core" as the next phase: Amrita must hold a project's durable state — what
  it is for, what is unknown, what could go wrong, and what the next chunks of work are — not
  just chat plus tasks/decisions/memory. The store/protocol pattern for this is established
  (ADR-0003/0004/0006/0007): entity tables via reversible migration, typed event payloads as the
  only write path, same-transaction projection, provenance columns everywhere.

## Decision

### Entities (migration `0004_companion`, schema v4)

- **`project_briefs`** — one row per project (`project_id` PRIMARY KEY): `goal` (≤2000 chars),
  optional `audience`, and three JSON string-arrays: `success_criteria_json`, `scope_json`,
  `no_scope_json`. Optional `source_message_id` provenance. The brief is an **upsert document**:
  `brief.updated` carries the whole brief, so replaying the log rebuilds the row exactly (same
  model as `memory.updated`).
- **`open_questions`** — `id`, `project_id`, optional `conversation_id`/`source_message_id`,
  `text`, `status ∈ {open, resolved, dropped}`, optional `resolution` note, optional
  `resolved_by_decision_id`, optional `drop_reason`. Two CHECK invariants:
  - resolved ⇒ a `resolution` note **or** a `resolved_by_decision_id` (a question cannot be
    waved away silently);
  - dropped ⇒ a `drop_reason`.
- **`risks`** — same lifecycle/invariants as questions, plus an optional tiny severity
  `∈ {low, medium, high}` (nullable; no scoring system, deliberately).
- **`milestones`** — `id`, `project_id`, `title`, optional `description`, `status ∈ {planned,
  active, done, dropped}`, optional `target_date` (ISO `YYYY-MM-DD`).
- **`tasks.milestone_id`** — nullable column linking a task to a milestone. Enforced by
  INSERT/UPDATE **triggers** (milestone must exist), not an FK clause, so the down migration can
  `DROP COLUMN` (the `conversations.parent_id` pattern from ADR-0003).
- **`idx_events_project_ts`** — index on `events(project_id, ts)` so the project timeline query
  is not a table scan.

`resolved_by_decision_id` existence is enforced by trigger against `decisions` (insert/update),
keeping the "resolutions trace to decisions when they claim to" promise at the SQL layer.

### Events (protocol additions, per the ADR-0004 taxonomy)

| Event | Payload (all `.strict()`) |
|---|---|
| `brief.updated` | `{projectId, goal, audience?, successCriteria[], scope[], noScope[], sourceMessageId?}` — full document |
| `question.opened` | `{questionId, projectId, conversationId?, sourceMessageId?, text}` |
| `question.resolved` | `{questionId, resolution?, resolvedByDecisionId?}` + refine: at least one of the two |
| `question.dropped` | `{questionId, reason}` |
| `risk.opened` | `{riskId, projectId, conversationId?, sourceMessageId?, text, severity?}` |
| `risk.resolved` | `{riskId, resolution?, resolvedByDecisionId?}` + same refine |
| `risk.dropped` | `{riskId, reason}` |
| `milestone.created` | `{milestoneId, projectId, title, description?, targetDate?, status?}` |
| `milestone.updated` | `{milestoneId, title?, description?, status?, targetDate?}` |
| `milestone.completed` | `{milestoneId}` |

Additionally `task.created`/`task.updated` gain an optional `milestoneId` (nullable on update, so
a task can be unlinked). All projections run in the same `appendEvent` transaction; a payload
that violates a table CHECK/trigger rolls back the event (ADR-0006 contract unchanged).

### Timeline is derived, not stored
There is **no** `timeline.*` event or table. The project timeline is a read of the existing
event log by `project_id` (newest first, bounded limit) — the log *is* the activity feed. This
keeps replay-equivalence trivially true and adds zero write-path cost.

### Provenance model
Every companion write carries the originating `projectId` + `conversationId` on the envelope and
optional `sourceMessageId` in the payload; resolutions may point at a decision row. The UI/CLI
never display companion facts without their typed rows, and never claim conversational
extraction that did not happen (intake in this phase is explicit: a human or a future agent turn
calls the typed RPC).

### Surfaces
- **Store API:** `upsertBrief/getBrief`, `openQuestion/resolveQuestion/dropQuestion/listQuestions`,
  `openRisk/resolveRisk/dropRisk/listRisks`, `createMilestone/updateMilestone/completeMilestone/
  listMilestones`, `listProjectEvents` (timeline), `updateTask({milestoneId})`.
- **RPC:** one aggregate read — `projects.companion.get {projectId}` → `{brief, questions, risks,
  milestones}` — plus focused mutations (`projects.brief.update`, `projects.questions.open|
  resolve|drop`, `projects.risks.open|resolve|drop`, `projects.milestones.create|update|complete`)
  and `projects.timeline.list {projectId, limit?}`. `tasks.create` accepts `milestoneId`.
- **CLI:** `amrita brief get|set`, `question list|open|resolve|drop`, `risk list|open|resolve|drop`,
  `milestone list|create|complete`, `timeline`.
- **Web:** Project Brain — brief card with edit form, questions/risks panels with
  resolve-with-note / drop-with-reason, milestones panel with task grouping, timeline panel, and
  next-actions v2 fed by the new typed state (still strictly rule-based).

## Intentionally deferred
- **Conversational intake/extraction** (an agent turn that proposes brief/questions from chat) —
  the typed write path this ADR creates is its target; the extraction itself is a later phase
  and must be labeled as a proposal, never auto-committed.
- Milestone ordering/dependencies, risk scoring beyond the 3-level severity, brief versioning
  (the event log already holds history; a UI for it can come later), and cross-project rollups.
- `approval.*` plumbing and operator mode (next phase per the roadmap).

## Consequences
A project's durable state is now typed, replayable, provenance-linked, and visible across web,
CLI, and RPC. The reducer/migration/tests discipline is unchanged — this is the fifth walk of
the same path (tasks, decisions, memory, lanes, companion). Future extraction agents and
operator mode consume these seams without further schema work.
