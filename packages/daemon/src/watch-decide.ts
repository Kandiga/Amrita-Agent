import type { AmritaEvent } from '@amrita/protocol';
import { scopesOverlap } from './lane-scope.ts';

/**
 * The Watcher's DECISION CORE (ADR-0048 §8.3) — pure and deterministic.
 *
 * `decideWatch(state, event)` folds one appended event into the watch state and
 * returns the actions the shell should take; `decideSweep(state, now)` is the
 * only time-based rule (stall / stuck approval), driven by an injected clock.
 * No store, no clock, no network here — the shell owns side effects.
 *
 * Detections are EVIDENCE-BACKED only (the plan's explicit boundary):
 * - failure/abort        ← `lane.aborted` (systemic/timeout aborts, not operator denials)
 * - budget/partial end   ← `lane.merge_report` exit
 * - cross-session overlap← two ACTIVE mandates with overlapping scope paths
 * - approval blockage    ← `approval.requested` unresolved past a threshold
 * - stall                ← an active lane with no progress past a threshold
 * There is deliberately NO semantic/prose "scope creep" detection and NO new
 * `watcher.*` event type: every output is an Inbox PROPOSAL (origin `lane`),
 * which the Conclusion Capsule already derives from. The dedup ledger guarantees
 * one action per fact — replays and duplicate deliveries fold to no-ops.
 */

export interface WatchLane {
  laneId: string;
  projectId: string;
  conversationId: string;
  goal: string;
  scopePaths: readonly string[];
  /** ISO of the last observed activity (progress/pane/spawn). */
  lastActivityTs: string;
}

export interface WatchApproval {
  approvalId: string;
  projectId: string;
  conversationId: string;
  laneId: string | undefined;
  requestedTs: string;
}

export interface WatchState {
  lanes: Record<string, WatchLane>;
  approvals: Record<string, WatchApproval>;
  /** Dedup ledger — one action per fact, ever (within this process). */
  actioned: Set<string>;
}

export interface WatchAction {
  /** Every Watcher output is an Inbox proposal — never a new event type. */
  kind: 'inbox';
  projectId: string;
  conversationId: string;
  text: string;
  rationale: string;
}

export function emptyWatchState(): WatchState {
  return { lanes: {}, approvals: {}, actioned: new Set() };
}

/** Thresholds (ms). Deliberately conservative — the Watcher nags, it never spams. */
export const WATCH_STALL_MS = 10 * 60_000;
export const WATCH_APPROVAL_MS = 3 * 60_000;

const once = (state: WatchState, key: string): boolean => {
  if (state.actioned.has(key)) return false;
  state.actioned.add(key);
  return true;
};

/** Fold one appended event; mutates `state` in place and returns actions. */
export function decideWatch(state: WatchState, ev: AmritaEvent): WatchAction[] {
  const actions: WatchAction[] = [];

  switch (ev.type) {
    case 'lane.mandate': {
      const m = ev.payload;
      const lane: WatchLane = {
        laneId: m.laneId,
        projectId: ev.projectId,
        conversationId: ev.conversationId,
        goal: m.goal,
        scopePaths: m.scope.paths ?? [],
        lastActivityTs: ev.ts,
      };
      // Cross-session conflict: overlapping scope with another ACTIVE lane in
      // the SAME project. The startLane gate covers spawn-time overlap; this
      // catches the pair once both actually hold mandates.
      for (const other of Object.values(state.lanes)) {
        if (other.projectId !== ev.projectId || other.laneId === lane.laneId) continue;
        if (
          lane.scopePaths.length > 0 &&
          other.scopePaths.length > 0 &&
          scopesOverlap(lane.scopePaths, other.scopePaths)
        ) {
          const pair = [lane.laneId, other.laneId].sort().join(':');
          if (once(state, `overlap:${pair}`)) {
            actions.push({
              kind: 'inbox',
              projectId: ev.projectId,
              conversationId: ev.conversationId,
              text: `Two active sessions share a workspace path — "${clip(lane.goal)}" and "${clip(other.goal)}" can overwrite each other.`,
              rationale: `Scope overlap between lanes ${lane.laneId} and ${other.laneId}.`,
            });
          }
        }
      }
      state.lanes[lane.laneId] = lane;
      return actions;
    }

    case 'lane.progress': {
      const laneId = ev.laneId;
      const lane = laneId ? state.lanes[laneId] : undefined;
      if (lane) lane.lastActivityTs = ev.ts;
      return actions;
    }

    case 'lane.merge_report': {
      const r = ev.payload;
      const lane = state.lanes[r.laneId];
      if (lane) lane.lastActivityTs = ev.ts;
      if ((r.exit === 'budget' || r.exit === 'partial') && once(state, `exit:${r.laneId}`)) {
        actions.push({
          kind: 'inbox',
          projectId: ev.projectId,
          conversationId: ev.conversationId,
          text:
            r.exit === 'budget'
              ? `A session ran out of budget before finishing: "${clip(lane?.goal ?? r.summary)}" — decide whether to extend or split the work.`
              : `A session ended early (partial): "${clip(lane?.goal ?? r.summary)}" — review what remains.`,
          rationale: `lane ${r.laneId} exited '${r.exit}': ${r.summary.slice(0, 160)}`,
        });
      }
      return actions;
    }

    case 'lane.completed': {
      delete state.lanes[ev.payload.laneId];
      return actions;
    }

    case 'lane.aborted': {
      const p = ev.payload;
      const lane = state.lanes[p.laneId];
      delete state.lanes[p.laneId];
      // Operator decisions (deny/cancel) are not failures — the human chose.
      const operatorChoice = /denied by operator|cancelled/i.test(p.reason ?? '');
      if (!operatorChoice && once(state, `abort:${p.laneId}`)) {
        actions.push({
          kind: 'inbox',
          projectId: ev.projectId,
          conversationId: ev.conversationId,
          text: `A session was aborted without finishing${lane ? `: "${clip(lane.goal)}"` : ''} — ${clip(p.reason ?? 'no reason recorded', 160)}.`,
          rationale: `lane ${p.laneId} aborted: ${(p.reason ?? '').slice(0, 160)}`,
        });
      }
      return actions;
    }

    case 'approval.requested': {
      state.approvals[ev.payload.approvalId] = {
        approvalId: ev.payload.approvalId,
        projectId: ev.projectId,
        conversationId: ev.conversationId,
        laneId: ev.laneId,
        requestedTs: ev.ts,
      };
      return actions;
    }

    case 'approval.resolved': {
      delete state.approvals[ev.payload.approvalId];
      return actions;
    }

    default:
      // Everything else — including the Watcher's OWN inbox.captured output —
      // is ignored by construction, so the loop can never feed itself.
      return actions;
  }
}

/** The only time-based rule; `now` is injected (ISO), never read from a clock. */
export function decideSweep(state: WatchState, now: string): WatchAction[] {
  const actions: WatchAction[] = [];
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return actions;

  for (const lane of Object.values(state.lanes)) {
    const idleMs = nowMs - Date.parse(lane.lastActivityTs);
    if (idleMs >= WATCH_STALL_MS && once(state, `stall:${lane.laneId}:${lane.lastActivityTs}`)) {
      actions.push({
        kind: 'inbox',
        projectId: lane.projectId,
        conversationId: lane.conversationId,
        text: `A session looks stalled — no activity for ${Math.round(idleMs / 60_000)} minutes: "${clip(lane.goal)}". Check its screen or cancel it.`,
        rationale: `lane ${lane.laneId} idle since ${lane.lastActivityTs}.`,
      });
    }
  }

  for (const approval of Object.values(state.approvals)) {
    const waitMs = nowMs - Date.parse(approval.requestedTs);
    if (waitMs >= WATCH_APPROVAL_MS && once(state, `approval:${approval.approvalId}`)) {
      actions.push({
        kind: 'inbox',
        projectId: approval.projectId,
        conversationId: approval.conversationId,
        text: `An approval has been waiting ${Math.round(waitMs / 60_000)} minutes — the session cannot start until you Allow or Deny it.`,
        rationale: `approval ${approval.approvalId}${approval.laneId ? ` (lane ${approval.laneId})` : ''} requested at ${approval.requestedTs}.`,
      });
    }
  }

  return actions;
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
