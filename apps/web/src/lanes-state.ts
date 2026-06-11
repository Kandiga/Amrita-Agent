/**
 * A pure, deterministic reducer over `lane.*` events for the web Lanes panel.
 *
 * Lane events arrive on the same live stream as the transcript (the Lanes panel
 * is fed from `App`'s `onEvent` alongside the transcript reducer). Replaying
 * history on (re)connect re-folds the same events; de-dupe by event id keeps it
 * idempotent. No secret value ever appears in a lane event payload.
 */

import type { AmritaEventLite } from './api.ts';

export type LaneStatus = 'spawned' | 'running' | 'merging' | 'completed' | 'aborted';

export interface LaneProgressNote {
  note: string;
  pct?: number;
}

export interface LaneView {
  id: string;
  kind: string;
  status: LaneStatus;
  goal?: string;
  progress: LaneProgressNote[];
  /** Merge-report exit: done | partial | aborted | budget | cancelled. */
  exit?: string;
  summary?: string;
  reason?: string;
  usage?: { inputTokens: number; outputTokens: number; usd?: number };
}

export interface LanesState {
  readonly seen: ReadonlySet<string>;
  readonly byId: Readonly<Record<string, LaneView>>;
  readonly order: readonly string[];
}

export function emptyLanes(): LanesState {
  return { seen: new Set(), byId: {}, order: [] };
}

/** The lane id of an event: envelope first (progress), then payload. */
function laneIdOf(ev: AmritaEventLite): string | undefined {
  if (ev.laneId) return ev.laneId;
  const fromPayload = ev.payload.laneId;
  return typeof fromPayload === 'string' ? fromPayload : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function upsert(
  state: LanesState,
  laneId: string,
  patch: (prev: LaneView) => LaneView,
  seen: Set<string>,
): LanesState {
  const existed = state.byId[laneId];
  const base: LaneView = existed ?? { id: laneId, kind: 'lane', status: 'spawned', progress: [] };
  const next = patch(base);
  return {
    seen,
    byId: { ...state.byId, [laneId]: next },
    order: existed ? state.order : [...state.order, laneId],
  };
}

/** Fold one event into lane state. Returns the same reference for no-op events. */
export function reduceLaneEvent(state: LanesState, ev: AmritaEventLite): LanesState {
  if (!ev.type.startsWith('lane.')) return state;
  if (ev.id && state.seen.has(ev.id)) return state; // de-dupe by event id
  const laneId = laneIdOf(ev);
  if (!laneId) return state;
  const seen = ev.id ? new Set(state.seen).add(ev.id) : new Set(state.seen);

  switch (ev.type) {
    case 'lane.spawned':
      return upsert(
        state,
        laneId,
        (p) => ({ ...p, kind: str(ev.payload.kind) ?? p.kind, status: 'spawned' }),
        seen,
      );
    case 'lane.mandate': {
      const goal = str(ev.payload.goal);
      return upsert(state, laneId, (p) => (goal !== undefined ? { ...p, goal } : { ...p }), seen);
    }
    case 'lane.progress':
      return upsert(
        state,
        laneId,
        (p) => ({
          ...p,
          status: p.status === 'spawned' ? 'running' : p.status,
          progress: [
            ...p.progress,
            {
              note: str(ev.payload.note) ?? '',
              ...(typeof ev.payload.pct === 'number' ? { pct: ev.payload.pct } : {}),
            },
          ],
        }),
        seen,
      );
    case 'lane.merge_report': {
      const usage = ev.payload.usage as LaneView['usage'] | undefined;
      return upsert(
        state,
        laneId,
        (p) => {
          const exit = str(ev.payload.exit) ?? p.exit;
          const summary = str(ev.payload.summary) ?? p.summary;
          return {
            ...p,
            status: 'merging',
            ...(exit !== undefined ? { exit } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(usage ? { usage } : {}),
          };
        },
        seen,
      );
    }
    case 'lane.completed':
      return upsert(
        state,
        laneId,
        (p) => {
          const exit = str(ev.payload.exit) ?? p.exit;
          return { ...p, status: 'completed', ...(exit !== undefined ? { exit } : {}) };
        },
        seen,
      );
    case 'lane.aborted':
      return upsert(
        state,
        laneId,
        (p) => {
          const reason = str(ev.payload.reason) ?? p.reason;
          return {
            ...p,
            status: 'aborted',
            ...(reason !== undefined ? { reason } : {}),
            exit: p.exit ?? 'aborted',
          };
        },
        seen,
      );
    default:
      return state;
  }
}

export function foldLaneEvents(state: LanesState, events: readonly AmritaEventLite[]): LanesState {
  let next = state;
  for (const ev of events) next = reduceLaneEvent(next, ev);
  return next;
}

/** Lanes in arrival order, most-recent first (for display). */
export function lanesList(state: LanesState): LaneView[] {
  return [...state.order]
    .reverse()
    .map((id) => state.byId[id])
    .filter((l): l is LaneView => !!l);
}

/** Whether a lane is in a non-terminal state (so it can be cancelled). */
export function isActive(lane: LaneView): boolean {
  return lane.status === 'spawned' || lane.status === 'running' || lane.status === 'merging';
}
