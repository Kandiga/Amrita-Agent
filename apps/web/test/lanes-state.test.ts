import { describe, expect, it } from 'vitest';
import type { AmritaEventLite } from '../src/api.ts';
import {
  type LaneView,
  emptyLanes,
  foldLaneEvents,
  isActive,
  lanesList,
  reduceLaneEvent,
} from '../src/lanes-state.ts';

function ev(partial: Partial<AmritaEventLite> & { id: string; type: string }): AmritaEventLite {
  return { seq: 0, ts: 't', payload: {}, ...partial };
}

const LANE = 'LANE0001';

describe('lanes-state reducer', () => {
  it('builds a lane through its lifecycle from stream events', () => {
    let s = emptyLanes();
    s = reduceLaneEvent(
      s,
      ev({ id: '1', type: 'lane.spawned', payload: { laneId: LANE, kind: 'claude-code' } }),
    );
    expect(lanesList(s)[0]).toMatchObject({ id: LANE, kind: 'claude-code', status: 'spawned' });

    s = reduceLaneEvent(
      s,
      ev({ id: '2', type: 'lane.mandate', payload: { laneId: LANE, goal: 'tidy the repo' } }),
    );
    expect(lanesList(s)[0]?.goal).toBe('tidy the repo');

    // progress carries laneId on the ENVELOPE, not the payload
    s = reduceLaneEvent(
      s,
      ev({ id: '3', type: 'lane.progress', laneId: LANE, payload: { note: 'working', pct: 50 } }),
    );
    expect(lanesList(s)[0]?.status).toBe('running');
    expect(lanesList(s)[0]?.progress.at(-1)).toEqual({ note: 'working', pct: 50 });

    s = reduceLaneEvent(
      s,
      ev({
        id: '4',
        type: 'lane.merge_report',
        payload: {
          laneId: LANE,
          exit: 'done',
          summary: 'did it',
          usage: { inputTokens: 5, outputTokens: 6 },
        },
      }),
    );
    expect(lanesList(s)[0]).toMatchObject({ status: 'merging', exit: 'done', summary: 'did it' });
    expect(lanesList(s)[0]?.usage).toMatchObject({ inputTokens: 5, outputTokens: 6 });

    s = reduceLaneEvent(
      s,
      ev({ id: '5', type: 'lane.completed', payload: { laneId: LANE, exit: 'done' } }),
    );
    expect(lanesList(s)[0]?.status).toBe('completed');
  });

  it('represents a cancelled lane as aborted status with exit cancelled', () => {
    let s = reduceLaneEvent(
      emptyLanes(),
      ev({ id: 'a', type: 'lane.spawned', payload: { laneId: LANE, kind: 'x' } }),
    );
    s = reduceLaneEvent(
      s,
      ev({
        id: 'b',
        type: 'lane.merge_report',
        payload: { laneId: LANE, exit: 'cancelled', summary: 'cancelled by operator' },
      }),
    );
    s = reduceLaneEvent(
      s,
      ev({
        id: 'c',
        type: 'lane.aborted',
        payload: { laneId: LANE, reason: 'cancelled by operator' },
      }),
    );
    expect(lanesList(s)[0]).toMatchObject({ status: 'aborted', exit: 'cancelled' });
  });

  it('ignores non-lane events and de-dupes replays by event id', () => {
    const s0 = emptyLanes();
    expect(
      reduceLaneEvent(s0, ev({ id: 'm', type: 'message.user', payload: { text: 'hi' } })),
    ).toBe(s0);

    const events = [
      ev({ id: '1', type: 'lane.spawned', payload: { laneId: LANE, kind: 'x' } }),
      ev({ id: '2', type: 'lane.progress', laneId: LANE, payload: { note: 'step' } }),
    ];
    const once = foldLaneEvents(emptyLanes(), events);
    const twice = foldLaneEvents(once, events); // a reconnect replay
    expect(lanesList(twice)[0]?.progress).toHaveLength(1); // not doubled
    expect(reduceLaneEvent(once, events[0] as AmritaEventLite)).toBe(once); // no-op, same ref
  });

  it('lists lanes most-recent-first and flags active ones', () => {
    let s = emptyLanes();
    s = reduceLaneEvent(
      s,
      ev({ id: '1', type: 'lane.spawned', payload: { laneId: 'A', kind: 'x' } }),
    );
    s = reduceLaneEvent(
      s,
      ev({ id: '2', type: 'lane.spawned', payload: { laneId: 'B', kind: 'x' } }),
    );
    expect(lanesList(s).map((l) => l.id)).toEqual(['B', 'A']);

    const running: LaneView = { id: 'r', kind: 'x', status: 'running', progress: [] };
    const done: LaneView = { id: 'd', kind: 'x', status: 'completed', progress: [] };
    expect(isActive(running)).toBe(true);
    expect(isActive(done)).toBe(false);
  });
});
