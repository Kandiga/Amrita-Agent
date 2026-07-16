import { describe, expect, it } from 'vitest';
import type { AmritaEventLite, SessionSnapshotLite } from '../src/api.ts';
import { emptySessions, hydrateSessionSnapshot, reduceSessionPane } from '../src/session-state.ts';

function pane(
  laneId: string,
  text: string,
  state: SessionSnapshotLite['state'] = 'running',
): AmritaEventLite {
  return {
    id: `e-${text}`,
    seq: 0,
    ts: '2026-07-15T00:00:00Z',
    type: 'lane.pane',
    laneId,
    payload: { laneId, text, state },
  };
}

describe('interactive session pane reducer (ADR-0050)', () => {
  it('keeps the latest full pane snapshot per lane with lifecycle state', () => {
    let state = emptySessions();
    state = reduceSessionPane(state, pane('l1', 'first'));
    state = reduceSessionPane(state, pane('l2', 'other', 'awaiting-auth'));
    state = reduceSessionPane(state, pane('l1', 'second', 'running'));
    expect(state).toEqual({
      l1: {
        text: 'second',
        state: 'running',
        live: true,
        capturedAt: '2026-07-15T00:00:00Z',
      },
      l2: {
        text: 'other',
        state: 'awaiting-auth',
        live: true,
        capturedAt: '2026-07-15T00:00:00Z',
      },
    });
  });

  it('hydrates an on-demand snapshot after refresh and lets live output replace it', () => {
    const snapshot: SessionSnapshotLite = {
      laneId: 'l1',
      text: 'captured after refresh',
      state: 'starting',
      live: true,
      capturedAt: '2026-07-15T00:00:00.000Z',
    };
    let state = hydrateSessionSnapshot(emptySessions(), snapshot);
    expect(state.l1).toEqual({
      text: snapshot.text,
      state: snapshot.state,
      live: true,
      capturedAt: snapshot.capturedAt,
    });

    state = reduceSessionPane(state, pane('l1', 'new live text', 'running'));
    expect(state.l1).toEqual({
      text: 'new live text',
      state: 'running',
      live: true,
      capturedAt: '2026-07-15T00:00:00Z',
    });

    const afterStaleSnapshot = hydrateSessionSnapshot(state, {
      ...snapshot,
      capturedAt: '2026-07-14T23:59:59.000Z',
      text: 'stale capture',
    });
    expect(afterStaleSnapshot).toBe(state);
  });

  it('does not let an equal-time unavailable capture replace a live pane', () => {
    const live = reduceSessionPane(emptySessions(), pane('l1', 'live', 'running'));
    const afterUnavailable = hydrateSessionSnapshot(live, {
      laneId: 'l1',
      text: '',
      state: 'unavailable',
      live: false,
      capturedAt: '2026-07-15T00:00:00Z',
    });
    expect(afterUnavailable).toBe(live);
  });

  it('ignores non-pane events and malformed payloads', () => {
    const before = hydrateSessionSnapshot(emptySessions(), {
      laneId: 'l1',
      text: 'kept',
      state: 'running',
      live: true,
      capturedAt: '2026-07-15T00:00:00.000Z',
    });
    const message: AmritaEventLite = {
      id: 'e2',
      seq: 1,
      ts: '2026-07-15T00:00:00Z',
      type: 'message.user',
      payload: { text: 'hello' },
    };
    expect(reduceSessionPane(before, message)).toBe(before);
    expect(
      reduceSessionPane(before, {
        ...pane('l1', 'bad'),
        payload: { laneId: 7, text: null, state: 'running' },
      }),
    ).toBe(before);
  });
});
