import { describe, expect, it } from 'vitest';
import type { AmritaEventLite, LaneRowLite } from '../src/api.ts';
import {
  type LaneView,
  emptyLanes,
  foldLaneEvents,
  isActive,
  lanesFromRows,
  lanesList,
  mergeLanesFromRows,
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

  it('hydrates project-scoped lane rows as the durable session source of truth', () => {
    const row = (partial: Partial<LaneRowLite> & Pick<LaneRowLite, 'id'>): LaneRowLite => ({
      projectId: '01J00000000000000000000001',
      conversationId: '01J00000000000000000000002',
      kind: 'claude-code-tmux',
      status: 'running',
      mandateJson: JSON.stringify({
        goal: 'build the project',
        scope: { paths: ['/workspace/project'] },
      }),
      budgetJson: null,
      mergeJson: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
      ...partial,
    });
    const state = lanesFromRows([
      row({ id: '01J00000000000000000000003' }),
      row({
        id: '01J00000000000000000000004',
        status: 'completed',
        createdAt: '2026-07-15T01:00:00.000Z',
        mandateJson: '{malformed',
        mergeJson: JSON.stringify({ exit: 'done', summary: 'completed safely' }),
      }),
    ]);

    const list = lanesList(state);
    expect(list.map((l) => l.id)).toEqual([
      '01J00000000000000000000004',
      '01J00000000000000000000003',
    ]);
    expect(list[1]).toMatchObject({
      kind: 'claude-code-tmux',
      status: 'running',
      goal: 'build the project',
      workspace: '/workspace/project',
    });
    expect(list[0]).toMatchObject({
      status: 'completed',
      exit: 'done',
      summary: 'completed safely',
    });
    expect(list[0]?.goal).toBeUndefined();
  });

  it('merges row hydration without wiping replayed progress or event-only lanes', () => {
    let live = reduceLaneEvent(
      emptyLanes(),
      ev({ id: 'spawn-1', type: 'lane.spawned', payload: { laneId: LANE, kind: 'codex-tmux' } }),
    );
    live = reduceLaneEvent(
      live,
      ev({
        id: 'progress-1',
        type: 'lane.progress',
        laneId: LANE,
        payload: { note: 'working', pct: 35 },
      }),
    );
    live = reduceLaneEvent(
      live,
      ev({ id: 'spawn-2', type: 'lane.spawned', payload: { laneId: 'EVENT_ONLY', kind: 'x' } }),
    );
    const row: LaneRowLite = {
      id: LANE,
      projectId: '01J00000000000000000000001',
      conversationId: '01J00000000000000000000002',
      kind: 'codex-tmux',
      status: 'spawned',
      mandateJson: JSON.stringify({ goal: 'from durable row' }),
      budgetJson: null,
      mergeJson: null,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    };

    const merged = mergeLanesFromRows(live, [row]);

    expect(merged.seen).toEqual(live.seen);
    expect(merged.byId[LANE]).toMatchObject({
      goal: 'from durable row',
      status: 'running',
      progress: [{ note: 'working', pct: 35 }],
    });
    expect(merged.byId.EVENT_ONLY).toBeDefined();
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

    const running: LaneView = { id: 'r', kind: 'x', status: 'running', progress: [], rev: 1 };
    const done: LaneView = { id: 'd', kind: 'x', status: 'completed', progress: [], rev: 1 };
    expect(isActive(running)).toBe(true);
    expect(isActive(done)).toBe(false);
  });
});

describe('lane modes (R4)', () => {
  it('maps ask/plan to the operator-gated policy and auto to auto-safe', async () => {
    const { approvalsForMode, LANE_MODES } = await import('../src/lanes-state.ts');
    expect(approvalsForMode('ask')).toBe('forward');
    expect(approvalsForMode('auto')).toBe('auto-safe');
    // plan is honestly unsupported: it is listed, disabled, and never faked
    const plan = LANE_MODES.find((m) => m.id === 'plan');
    expect(plan?.supported).toBe(false);
    expect(plan?.label).toContain('unsupported');
    // even if forced, plan falls back to the gated policy — never a silent auto
    expect(approvalsForMode('plan')).toBe('forward');
  });
});
