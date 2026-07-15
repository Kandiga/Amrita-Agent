# ADR-0048: Amrita as an orchestration layer over execution agents

- **Status:** Accepted
- **Date:** 2026-07-15
- **Builds on:** ADR-0044/0045 (PM-OS: Inbox, `captureMergeReport`, "lane proposes, human disposes"),
  ADR-0021 (approval broker), ADR-0039 (lane workspace jail), ADR-0034 (bounded project context)

## Context

Amrita's binding principle is *"she is the project's managerial brain; Claude Code and Codex are
the execution arms."* Today the chat path (`kernel.ts runChatTurn`) is a straight line
provider→text with **no delegation decision**, and the `AMRITA_CAPABILITIES` preamble
(`context-pack.ts`) instructs the model to emit a complete build as ```` ```html ```` in the reply.
So "build X" is defined, end-to-end, as *a chat completion that prints code* — not as a supervised
execution session. Every managerial mechanism (routing, mandate, approval, merge-back) already
exists but is bolted to a **task** and reachable only via **manual RPCs**; a chat message never
enters it. There is also no watcher, no restart reconciliation, and no conclusion surface.

This ADR governs the schema/contract changes that turn the existing chat + lane infrastructure into
an orchestration layer. It does **not** create a parallel truth store: the event log remains SSOT.

## Decision

1. **A Planner, sibling of the Scribe.** Build intent is classified by a **pure, deterministic**
   extension of `execution-route.ts` (`classifyIntent`), and a best-effort post-turn pass
   (`runPlanner`, off the reply path, provider-agnostic, fake-injectable) synthesizes a `LaneMandate`
   from project truth and opens a **managed session** via the existing `startLane`. No pre-provider
   hard classifier short-circuits her reply; the prompt is a soft steer and the route is the backstop.

2. **Everything to a session.** `AMRITA_CAPABILITIES` is rewritten so build/visual/interactive work
   is delegated to a session, not printed in chat. The Canvas shows the session (workspace + live
   output), not chat-scraped HTML. Behind a kill-switch `settings['orchestration.enabled']`.

3. **Agent selection is `kind` selection, first-class and visible.** A pure `resolveAgent`
   (override > policy) chooses claude-code vs codex vs research vs human, honest ("needs setup" with
   the exact `nextCommand`) when a runtime is not ready. The operator can always pick per job; the
   default policy only fills the unspecified case.

4. **The lane↔task link becomes event-derivable.** `task.updated` gains an additive-optional
   `laneId`, and `delegateTask` records the link through `store.updateTask` (the single write path)
   instead of a raw `UPDATE tasks SET lane_id` off the event log. This is the prerequisite for any
   event-driven watcher or task-status transition.

5. **The Watcher reuses existing rails.** An event-driven consumer (`store.subscribe`, not polling)
   detects cross-session conflict, failure/budget/partial, blockage, and stall from existing
   `lane.*`/`approval.*` signals. Its outputs are `requestApproval` / `cancelLane` /
   `captureInboxItem` / the capsule — **no new `watcher.*` event type**. It does not attempt
   prose-based scope-creep detection (the ADR-0039 jail hard-covers path scope) or semantic drift.

6. **The Conclusion Capsule is a derived view, never an event.** Progress / Decisions / Risks /
   Conflicts / Validation / Next-Actions, each provenance-linked, delivered as an **RPC result wire
   type** built purely from `lane.* + inbox.* + task.* + approval.*` rows. It never enters the event
   log and is never a write path (a test guards this).

7. **The Approval Constitution.** A pure `resolveApprovalPolicy(mandate, posture)` replaces the
   one-line gate at the lane spawn, closing the hole where `auto-safe`/`sandboxed` blindly skipped
   approval. Operational-reversible work (dry-run, read-only research, a jailed edit within budget)
   proceeds; material work (writes to the shared root, spend over threshold, network egress,
   scope-overlap, deploy/push/publish/migrate, cross-project, or an interactive tmux session — see
   ADR-0049) is gated. The `approvals` field keeps its three names as declared intent; the resolver
   gives them honest teeth.

8. **Restart recovery + idempotency, derived from the lanes row.** No new orchestration table: the
   lanes row already persists every durable session fact. On boot, `reconcileLanesOnBoot` sweeps
   non-terminal lanes with no live handle and aborts them honestly (`lane.aborted`, `origin:'system'`)
   — except re-attachable tmux sessions (ADR-0049). An additive-optional `idempotencyKey` on
   `lane.spawned` + a nullable column + partial unique index closes the crash-window duplicate-lane
   bug in `delegateTask`.

9. **Lane→task transition is confidence-gated (owner decision, 2026-07-15).** Only the safe,
   reversible class (`exit:'done'` + criteria met or absent) auto-advances the linked task to a
   review-equivalent state — mirroring the Scribe's auto-open-questions boundary; everything else is
   an Inbox proposal. Never a silent `done` on unverified work. Flag: `orchestration.autoTaskTransition`.

## Consequences

Additive-optional protocol only: `task.updated.laneId?`, `lane.spawned` gains `idempotencyKey?`
plus the ADR-0049 session/correlation fields; a single migration adds nullable columns to the
existing `lanes` table (no new table → `deleteProject` cascade and `REQUIRED_TABLES` unchanged). Old
events replay byte-identically. New logic lives in pure `.ts` modules (`agent-select`,
`mandate-synth`, `lane-approval`, `lane-scope`, `watch-decide`, `conclusion-capsule`) with unit
tests; the kernel seams (`runPlanner`, `startLaneFromChat`, `reconcileLanesOnBoot`) are thin.
Autonomous delegation defaults to the headless one-shot runners; the tmux interactive mode
(ADR-0049) is operator-initiated or gated.
