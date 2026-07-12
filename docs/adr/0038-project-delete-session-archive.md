# ADR-0038 — Deleting a project, archiving a session

- **Status:** accepted (2026-07-12)
- **Context:** the sidebar (Screenshot Brief, region 1) needs delete controls for
  projects and for sessions inside a project.

## Decision

1. **Session "delete" = archive.** `conversation.archive` RPC emits the existing
   `conversation.archived` event (projection sets `archived_at` since ADR-0033); the
   session disappears from the sidebar but its history stays in the append-only log —
   consistent with the compression lifecycle, zero store change. The UI says
   "Archive" and the tooltip states the history is preserved.
2. **Project delete is REAL and explicit.** `project.delete` removes the project and
   everything it owns (events, messages, conversations, tasks, decisions, questions,
   risks, milestones, briefs, brands, preview approvals, project-scoped memory, lanes)
   in ONE transaction (`store.deleteProject`). This is the single sanctioned
   destructive verb in the API; the UI requires typing the project slug to confirm.
   The reserved `system` project cannot be deleted (refused, `conflict`).

## Amendment: the decisions append-only trigger

Migration `0008_project_delete_cascade` re-scopes `decisions_no_delete`: a delete is
permitted only while the settings key `cascade.project.delete` holds that row's exact
`project_id`. `store.deleteProject` sets the flag, cascades, and clears it **inside the
same transaction**, so the gate is unobservable outside the cascade. Casual deletes
still abort; row-level immutability (no updates, superseding rows for corrections)
is untouched.

## Invariants & guards

- `project.delete` refuses `system` and unknown ids; the whole cascade is one
  transaction (partial deletes are impossible).
- Store-level test proves: rows of every owned table are gone, OTHER projects'
  rows survive, and the operation is atomic.
- Wire coverage (ADR-0032) forces result schemas for both verbs.

## Rollback

Verbs are additive. A deleted project is NOT recoverable (stated in the UI) — that is
the feature, not a defect; the confirm-by-slug gate is the safety.
