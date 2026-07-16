# ADR-0053: Durable idempotency for lane creation

- **Status:** Accepted
- **Date:** 2026-07-16
- **Builds on:** ADR-0048 (orchestration), ADR-0049 (execution sessions), ADR-0050 (project-scoped Session Workspace)

## Context

`lanes.start` created a fresh lane on every call. The task delegation path had an
in-memory-looking guard (`tasks.lane_id`), but a crash could commit
`lane.spawned` before the task link was written. A retry would then create a
second execution lane for the same task. RPC retries and two daemon processes
could produce the same duplicate.

The event log must remain the write authority, old `lane.spawned` events must
replay unchanged, and idempotency cannot be an in-memory cache because it must
survive process and host restarts.

## Decision

1. **Optional bounded event field.** `lane.spawned` gains
   `idempotencyKey?: string` with length `1..200`. It is optional so every
   pre-0053 event remains valid and byte-equivalent on replay.
2. **Durable claim in the existing lane projection.** Migration 0018 adds the
   nullable `lanes.idempotency_key` column and a partial unique index over
   non-null values. No new orchestration table or second truth store is added.
   The same migration also carries the ADR-0049 orchestration-correlation
   columns — nullable `group_id`, `role` (`build|qa|compare`, CHECK-guarded) and
   `verifies_lane_id`, with partial indexes `idx_lanes_group` /
   `idx_lanes_verifies_lane` — one reversible step for one release, and
   `lane.spawned` gains the matching additive-optional fields.
3. **Lookup-before-create plus database race closure.** `startLane` first looks
   up the key. The unique index remains the authority if two processes both miss
   that optimistic lookup. A losing append rolls back atomically; the loser may
   return the winner only after proving the same operation identity.
4. **Fail closed on key reuse.** The COMPLETE operation identity must match:
   conversation, lane kind, goal, and the NORMALIZED correlation (`groupId`,
   `role`, `verifiesLaneId` after defaulting — e.g. a verification target
   implies `role: qa` and inherits the target's group). A key reused with any
   other identity is a conflict; cross-project collisions never return a
   foreign lane.
5. **Task delegation namespace.** `delegateTask` supplies
   `delegate:<taskId>`. This closes the crash window between lane creation and
   the event-sourced `task.updated.laneId` link while retaining the existing
   already-linked-task guard.
6. **At-most-once, not hidden retry execution.** A claimed row is never used to
   launch a second runner. If a process dies before its mandate/run completes,
   existing reconcile semantics expose/abort the incomplete lane rather than
   silently creating duplicate execution.

## Consequences

- RPC/client retries and same-process concurrent submissions converge on one
  lane and one lifecycle event chain.
- The database, not process memory, decides the cross-process race.
- A global key must be namespaced by callers; task IDs are globally unique.
- `LaneRow` exposes the key and the store provides a read-only key lookup.
- The field is operational provenance, not a credential; it is bounded and must
  never contain secret values.

## Verification / fitness functions

- Legacy and keyed `lane.spawned` payloads both parse; empty/oversized keys fail.
- Migration 0018 performs up → down → up and restores/removes both column and
  index correctly.
- Duplicate keys reject the second projection and roll back its event.
- Projection rebuild preserves the key and returns the same lookup result.
- Concurrent same-key kernel starts produce one lane and one
  `lane.spawned`/`lane.mandate` pair.
- Same key with another conversation/kind/goal fails closed.
- `tasks.delegate` records `delegate:<taskId>` on `lane.spawned`.
- The RPC boundary rejects keys outside `1..200`.
