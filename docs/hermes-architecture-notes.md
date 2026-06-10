# Hermes Agent — architecture notes for Amrita v2

A bounded read of Hermes Agent (`/usr/local/lib/hermes-agent`, reference only — no code copied) to
de-risk Amrita's store/agent boundary. Each lesson is tied to a concrete Amrita decision.

- **One transaction for log + projection, lock acquired up front.** Hermes wraps every mutation in
  `BEGIN IMMEDIATE … commit()` with rollback-on-exception (`hermes_state._execute_write`), and notes
  that a transcript rewrite "must commit as one transaction so a mid-rewrite failure does not leave a
  partial transcript" (`replace_messages`). → Amrita: `appendEvent` runs the event insert **and**
  `applyEventProjection` in one tx; a failed projection rolls back the event (ADR-0006).

- **Update denormalized rollups in the same write, never in a later pass.** `append_message` bumps
  `sessions.message_count`/`tool_call_count` atomically with the row insert. → Amrita: `appendEvent`
  touches `conversations.updated_at` inside the tx; any future counters (message/lane rollups) go the
  same way — no second-pass reconciliation.

- **Keep all I/O out of the write path; fire side effects after commit.** Hermes runs checkpoints,
  guardrails, and provider notifications around tool execution (`tool_executor.py`), separate from the
  canonical `messages.append`. → Amrita: the reducer is SQLite-only (no fs/network/clock); notifications
  and the agent loop react post-commit, keyed off `seq`. (Known debt: the WO#0 spill still writes a file
  in-tx — flagged in ADR-0006 for relocation.)

- **Validate before the row lands; never let an invalid shape into canonical state.** Hermes repairs
  the tail and normalizes tool results so "a rejected tool result never poisons canonical history"
  (`run_agent._drop_trailing_empty_response_scaffolding`, `tool_executor`). → Amrita: `parseUnsealedEvent`
  + `parseEvent` gate every append; CHECKs/FKs/triggers reject bad rows and roll the event back.

- **Track lineage as an explicit indexed `parent_id` chain; reassemble via a recursive walk.** Hermes
  stores `parent_session_id` (FK+index) and rebuilds a logical conversation with a recursive CTE
  (`hermes_state`). → Amrita: `conversations.parent_id` (ADR-0003) is indexed; "full thread" reads will
  be a recursive walk, not forward-copied rows.

- **Model compaction as close-old → open-child → carry a summary, transactionally.** `compress_context`
  does `end_session(old) → create_session(parent=old)` and starts the child empty, inheriting via
  lineage rather than duplicating rows. → Amrita: a future compaction is its own event creating a child
  conversation (`parent_id` set) plus one summary/decision row — never an UPDATE of prior messages
  (consistent with append-only `decisions`).

- **Make lifecycle boundaries explicit instead of inferring from diffs.** Hermes passes
  `boundary_reason="compression"` / `reset=False` to its hooks so consumers branch correctly
  (`conversation_compression`, `_transition_context_engine_session`). → Amrita: use distinct event
  types (new-conversation vs compaction-continuation vs reset) so reducers/consumers branch on type,
  not on row deltas.

- **Reuse the monotonic counter as both idempotency key and cache-invalidation key.** Hermes bumps a
  registry `_generation` for memoization and guards DB flushes with `_last_flushed_db_idx` to avoid
  double-writes from multiple exit paths. → Amrita: the per-conversation `seq` is the dedupe key for
  at-least-once consumers and the memo key for cached read models.

- **Separate registry/dispatch from execution, and uniform-wrap errors at the seam.** `ToolRegistry`
  only stores schemas/handlers and `dispatch()`-es, catching handler errors into a typed `{error}`
  shape; orchestration lives elsewhere (`tools/registry.py` vs `tool_executor.py`). → Amrita: the
  event→reducer mapping is a pure, table-driven dispatch (`applyEventProjection`) kept separate from
  whatever agent code decides *which* events to emit; all reducer failures funnel to one rollback path.
