import type { AmritaEventLite, SessionSnapshotLite } from './api.ts';

/** Ephemeral interactive-session screen state. Pane text is never persisted. */
export interface SessionPaneView {
  text: string;
  state: SessionSnapshotLite['state'];
  live: boolean;
  capturedAt?: string;
}

/** Latest redacted pane snapshot by lane id (ADR-0050). */
export type SessionPanes = Record<string, SessionPaneView>;

export function emptySessions(): SessionPanes {
  return {};
}

const SESSION_STATES = new Set<SessionSnapshotLite['state']>([
  'awaiting-approval',
  'starting',
  'awaiting-auth',
  'running',
  'finishing',
  'completed',
  'aborted',
  'unavailable',
]);

function isOlder(timestamp: string, than?: string): boolean {
  if (!than) return false;
  const a = Date.parse(timestamp);
  const b = Date.parse(than);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}

function isSameOrOlder(timestamp: string, than?: string): boolean {
  if (!than) return false;
  const a = Date.parse(timestamp);
  const b = Date.parse(than);
  return Number.isFinite(a) && Number.isFinite(b) && a <= b;
}

/** Fold a live, full-pane `lane.pane` snapshot into the project session map. */
export function reduceSessionPane(state: SessionPanes, ev: AmritaEventLite): SessionPanes {
  if (ev.type !== 'lane.pane') return state;
  const laneId = ev.laneId ?? ev.payload.laneId;
  const text = ev.payload.text;
  const runtimeState = ev.payload.state;
  if (
    typeof laneId !== 'string' ||
    typeof text !== 'string' ||
    typeof runtimeState !== 'string' ||
    !SESSION_STATES.has(runtimeState as SessionSnapshotLite['state'])
  ) {
    return state;
  }
  const current = state[laneId];
  if (isOlder(ev.ts, current?.capturedAt)) return state;
  return {
    ...state,
    [laneId]: {
      text,
      state: runtimeState as SessionSnapshotLite['state'],
      live: true,
      capturedAt: ev.ts,
    },
  };
}

/** Hydrate one lane from the read-only snapshot RPC after refresh/reconnect. */
export function hydrateSessionSnapshot(
  state: SessionPanes,
  snapshot: SessionSnapshotLite,
): SessionPanes {
  const current = state[snapshot.laneId];
  if (isOlder(snapshot.capturedAt, current?.capturedAt)) return state;
  // A failed/offline capture racing a live frame from the same clock tick must not
  // blank a healthy terminal screen.
  if (current?.live && !snapshot.live && isSameOrOlder(snapshot.capturedAt, current.capturedAt)) {
    return state;
  }
  return {
    ...state,
    [snapshot.laneId]: {
      text: snapshot.text,
      state: snapshot.state,
      live: snapshot.live,
      capturedAt: snapshot.capturedAt,
    },
  };
}
