import { describe, expect, it } from 'vitest';
import type { AmritaEventLite } from '../src/api.ts';
import { emptySessions, reduceSessionPane } from '../src/session-state.ts';

const pane = (laneId: string, text: string): AmritaEventLite => ({
  id: `e-${Math.random()}`,
  seq: 0,
  ts: '2026-07-15T00:00:00Z',
  type: 'lane.pane',
  laneId,
  payload: { laneId, text },
});

describe('session-state — live pane snapshots (ADR-0049)', () => {
  it('keeps the LATEST snapshot per lane (replace, not append)', () => {
    let s = emptySessions();
    s = reduceSessionPane(s, pane('L1', 'first'));
    s = reduceSessionPane(s, pane('L1', 'second'));
    s = reduceSessionPane(s, pane('L2', 'other'));
    expect(s.L1).toBe('second');
    expect(s.L2).toBe('other');
  });

  it('ignores non-pane events and returns the same reference (no needless re-render)', () => {
    const s0 = { L1: 'x' };
    const other: AmritaEventLite = {
      id: 'e',
      seq: 1,
      ts: 't',
      type: 'lane.progress',
      laneId: 'L1',
      payload: { note: 'working' },
    };
    expect(reduceSessionPane(s0, other)).toBe(s0);
    expect(reduceSessionPane(s0, pane('L1', 'x'))).toBe(s0); // identical snapshot → same ref
  });
});
