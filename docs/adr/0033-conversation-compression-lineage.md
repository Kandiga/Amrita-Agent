# ADR-0033 — Conversation compression as lineage (child session carries the summary)

- **Status:** accepted (2026-07-12)
- **Context:** reorganization stage R1 (`docs/strategy/reorganization-master-plan.md` §1.1,
  "Compress"); Hermes research §1 (compaction-as-child-session is the proven shape).

## Decision

A long conversation is never rewritten. `conversation.compress` creates a **child
conversation** (existing `conversations.parent_id` lineage, ADR-0003) that starts with a
`message.system` carrying a **deterministic digest** of the parent, then marks the parent:

1. child = `createConversation({ projectId, title: "<title> · continued", parentId })`;
2. child gets `message.system` `{ text: <digest> }` (origin `system`) — so the next chat
   turn there has context without replaying the parent;
3. parent gets a new event **`conversation.compressed`**
   `{ childConversationId, summary, messageCount }` (bounded summary ≤ 4000);
4. parent gets `conversation.archived` — which now HAS a projection: it sets
   `conversations.archived_at = ev.ts` (the event existed since Phase 0 but was never
   emitted or projected; this ADR activates it).

The digest is **deterministic** (no LLM): title, message counts by role, time span, and
the last 5 messages truncated to 200 chars each. An LLM-written summary is a future,
provider-gated enhancement — a deterministic digest is honest and replayable today.

New wire surface: RPC `conversation.compress` (+ result schema in `rpcResultSchemas`,
enforced by the ADR-0032 coverage test) and CLI `amrita compress`.

## Invariants & guards

- The event log stays append-only; replaying the parent still works (E1 test).
- Compressing an empty conversation is refused (`invalid_params`-class error).
- Compressing an already-archived conversation is refused (no double-compression chains
  by accident; the child is the place to continue).
- Lineage: `child.parentId === parent.id`; `conversation.compressed.childConversationId`
  closes the loop from the log side.

## Rollback

Additive only: one new event type + one projection case + one RPC verb. Reverting the
code leaves old `conversation.compressed` events as unprojected log entries (harmless).
