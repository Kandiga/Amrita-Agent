import { describe, expect, it } from 'vitest';
import type { LaneView } from '../src/lanes-state.ts';
import { buildMissionRows } from '../src/mission-control.ts';

/** HARMONY-1 — Mission Control derives one row per thread, attention-first. */

const lane = (id: string, status: LaneView['status']): LaneView =>
  ({ id, kind: 'claude-code-tmux', status, rev: 1 }) as LaneView;

const task = (over: Record<string, unknown>) => ({
  id: 't1',
  title: 'Build it',
  status: 'now',
  laneId: null,
  ...over,
});

describe('buildMissionRows', () => {
  it('joins task → session → approval → evidence into one row', () => {
    const rows = buildMissionRows(
      [
        task({
          id: 't1',
          laneId: 'L1',
          acceptanceJson: JSON.stringify([{ kind: 'command', run: 'pnpm test' }]),
        }),
      ],
      { L1: lane('L1', 'running') },
      [{ approvalId: 'A1', action: 'lane.run-real', laneId: 'L1' } as never],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lane?.status).toBe('running');
    expect(rows[0]?.approval?.approvalId).toBe('A1');
    expect(rows[0]?.evidence).toBe('unverified');
    expect(rows[0]?.attention).toBe(0); // the approval outranks everything
  });

  it('orders by attention: approval > failed evidence > live session > waiting', () => {
    const rows = buildMissionRows(
      [
        task({ id: 'a', title: 'a', blockedReason: 'review me' }),
        task({
          id: 'b',
          title: 'b',
          acceptanceJson: '[{"kind":"file","path":"x"}]',
          verificationJson: '{"at":"t","passed":false,"results":[{"ok":false}]}',
        }),
        task({ id: 'c', title: 'c', laneId: 'L2' }),
      ],
      { L2: lane('L2', 'running') },
      [],
    );
    expect(rows.map((r) => r.taskId)).toEqual(['b', 'c', 'a']);
  });

  it('excludes unthreaded, done and dropped tasks (a quiet board stays quiet)', () => {
    const rows = buildMissionRows(
      [
        task({ id: 'plain' }),
        task({ id: 'done', status: 'done', laneId: 'L1' }),
        task({ id: 'dropped', status: 'dropped', laneId: 'L1' }),
      ],
      { L1: lane('L1', 'completed') },
      [],
    );
    expect(rows).toHaveLength(0);
  });

  it('passing evidence reads as pass with a review nudge', () => {
    const rows = buildMissionRows(
      [
        task({
          acceptanceJson: '[{"kind":"file","path":"x"}]',
          verificationJson: '{"at":"t","passed":true,"results":[{"ok":true}]}',
        }),
      ],
      {},
      [],
    );
    expect(rows[0]?.evidence).toBe('pass');
    expect(rows[0]?.next).toMatch(/review/i);
  });
});
