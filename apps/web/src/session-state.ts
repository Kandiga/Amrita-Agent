import type { AmritaEventLite } from './api.ts';

/**
 * Live interactive-session panes (ADR-0049). Each `lane.pane` event carries a full
 * pane SNAPSHOT (not a delta), so the state is simply the latest snapshot per lane —
 * REPLACE, never append. Stream-only: these never persist, they are what the operator
 * watches. Pure and reducer-shaped, like `lanes-state.ts`.
 */
export type SessionPanes = Record<string, string>;

export function emptySessions(): SessionPanes {
  return {};
}

export function reduceSessionPane(state: SessionPanes, ev: AmritaEventLite): SessionPanes {
  if (ev.type !== 'lane.pane') return state;
  const payload = (ev.payload ?? {}) as { laneId?: string; text?: string };
  const laneId = ev.laneId ?? payload.laneId;
  if (!laneId || typeof payload.text !== 'string') return state;
  if (state[laneId] === payload.text) return state; // no-op: identical snapshot
  return { ...state, [laneId]: payload.text };
}
