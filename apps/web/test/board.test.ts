import type { TaskRowWire } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildBoard,
  columnOf,
  isOverdue,
  isTerminal,
  keyBetween,
  keyForDrop,
  updateForDrop,
} from '../src/board.ts';

const TS = '2026-07-14T10:00:00.000Z';

const task = (over: Partial<TaskRowWire> = {}): TaskRowWire => ({
  id: 't1',
  projectId: 'p1',
  conversationId: null,
  sourceMessageId: null,
  laneId: null,
  milestoneId: null,
  status: 'now',
  title: 'File the permit',
  body: null,
  owner: null,
  dueDate: null,
  priority: null,
  orderKey: null,
  blockedReason: null,
  certainty: null,
  phaseId: null,
  version: 0,
  derivedFrom: [],
  externalRef: null,
  createdAt: TS,
  updatedAt: TS,
  ...over,
});

describe('board columns (ADR-0044)', () => {
  it('maps status to a column', () => {
    expect(columnOf(task({ status: 'now' }))).toBe('now');
    expect(columnOf(task({ status: 'later' }))).toBe('later');
    expect(columnOf(task({ status: 'done' }))).toBe('done');
  });

  it('puts a BLOCKED task in Waiting — without the status enum knowing about it', () => {
    const t = task({ status: 'now', blockedReason: 'the council has not replied' });
    expect(columnOf(t)).toBe('waiting');
    expect(t.status).toBe('now'); // the enum is untouched (SQLite cannot alter a CHECK)
  });

  it('a done task is Done even if it was once blocked', () => {
    expect(columnOf(task({ status: 'done', blockedReason: 'x' }))).toBe('done');
  });

  it('drops a dropped task off the board entirely', () => {
    expect(columnOf(task({ status: 'dropped' }))).toBeNull();
  });

  it('builds four columns and files every task', () => {
    const board = buildBoard([
      task({ id: 'a', status: 'now' }),
      task({ id: 'b', status: 'later' }),
      task({ id: 'c', status: 'now', blockedReason: 'waiting on Dana' }),
      task({ id: 'd', status: 'done' }),
      task({ id: 'e', status: 'dropped' }),
    ]);
    expect(board.map((c) => `${c.id}:${c.tasks.length}`)).toEqual([
      'now:1',
      'waiting:1',
      'later:1',
      'done:1',
    ]);
  });

  it('orders by the fractional index, unranked tasks last', () => {
    const board = buildBoard([
      task({ id: 'c', orderKey: null, createdAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'b', orderKey: 'b' }),
      task({ id: 'a', orderKey: 'a' }),
    ]);
    expect(board[0]?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('phase mode — the board is born from the project (ADR-0045)', () => {
  const phases = [
    { id: 'ph1', title: 'Permits', status: 'active' },
    { id: 'ph2', title: 'Vendors', status: 'planned' },
  ];

  it('with no phases, falls back HONESTLY to the four status buckets', () => {
    const board = buildBoard([task({ id: 'a' })], []);
    expect(board.map((c) => c.title)).toEqual(['Now', 'Waiting', 'Later', 'Done']);
    expect(board.every((c) => !c.isPhase)).toBe(true);
  });

  it('with phases, the COLUMNS ARE THE PHASES — not a template', () => {
    const board = buildBoard(
      [
        task({ id: 'a', phaseId: 'ph1', title: 'File the permit' }),
        task({ id: 'b', phaseId: 'ph2', title: 'Call the caterer' }),
      ],
      phases,
    );
    expect(board.map((c) => c.title)).toEqual(['Permits', 'Vendors', 'Done']);
    expect(board[0]?.isPhase).toBe(true);
    expect(board[0]?.tasks.map((t) => t.id)).toEqual(['a']);
    expect(board[1]?.tasks.map((t) => t.id)).toEqual(['b']);
  });

  it('an UNPHASED task never silently vanishes from the board', () => {
    const board = buildBoard([task({ id: 'x', phaseId: null })], phases);
    const unphased = board.find((c) => c.title === 'Unphased');
    expect(unphased?.tasks.map((t) => t.id)).toEqual(['x']);
  });

  it('a task pointing at a DELETED phase still shows up', () => {
    const board = buildBoard([task({ id: 'x', phaseId: 'gone' })], phases);
    expect(board.find((c) => c.title === 'Unphased')?.tasks).toHaveLength(1);
  });

  it('a done task reads as Done even inside phase mode', () => {
    const board = buildBoard([task({ id: 'a', phaseId: 'ph1', status: 'done' })], phases);
    expect(board.find((c) => c.title === 'Permits')?.tasks).toHaveLength(0);
    expect(board.find((c) => c.title === 'Done')?.tasks).toHaveLength(1);
  });

  it('ignores a dropped phase', () => {
    const board = buildBoard([], [...phases, { id: 'ph3', title: 'Cancelled', status: 'dropped' }]);
    expect(board.map((c) => c.title)).not.toContain('Cancelled');
  });

  it('dropping onto a phase column MOVES THE PHASE, and never widens the status enum', () => {
    const t = task({ id: 'a', phaseId: 'ph1', blockedReason: 'waiting on the council' });
    expect(updateForDrop(t, 'ph2', 'a0', true)).toEqual({
      orderKey: 'a0',
      phaseId: 'ph2',
      blockedReason: null,
      status: 'now',
    });
  });
});

describe('the fractional index — a drag is ONE event on ONE row', () => {
  it('produces a key strictly between two neighbours', () => {
    const k = keyBetween('a', 'c');
    expect(k > 'a').toBe(true);
    expect(k < 'c').toBe(true);
  });

  it('handles ADJACENT keys by descending, not by renumbering siblings', () => {
    const k = keyBetween('a', 'b');
    expect(k > 'a').toBe(true);
    expect(k < 'b').toBe(true);
  });

  it('appends after the last card', () => {
    expect(keyBetween('m', null) > 'm').toBe(true);
  });

  it('prepends before the first card', () => {
    const k = keyBetween(null, 'b');
    expect(k < 'b').toBe(true);
  });

  it('returns a key for an empty column', () => {
    expect(keyBetween(null, null).length).toBeGreaterThan(0);
  });

  it('survives 200 repeated inserts at the SAME position without collapsing', () => {
    // The pathological case: always drop between the first two cards. An integer
    // scheme would renumber the world; this must just grow the key slowly.
    let lo = 'a';
    const hi = 'b';
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo).toBe(true);
      expect(k < hi).toBe(true);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      lo = k;
    }
  });

  it('never throws on a degenerate range (a drag handler must not crash)', () => {
    expect(() => keyBetween('c', 'a')).not.toThrow();
    expect(keyBetween('c', 'a').length).toBeGreaterThan(0);
  });

  it('NEVER generates a terminal key — or nothing could be dropped above it again', () => {
    // Invariant 1: a key ending in the zero digit ('a') can have nothing inserted
    // before it, because a lexicographic string cannot go "below zero". Every
    // generator path must therefore avoid it.
    const generated: string[] = [
      keyBetween(null, null),
      keyBetween(null, 'b'),
      keyBetween(null, 'n'),
      keyBetween('a', 'b'),
      keyBetween('y', 'z'),
      keyBetween('z', null),
      keyBetween('m', null),
    ];
    let lo: string | null = null;
    for (let i = 0; i < 50; i++) {
      const k: string = keyBetween(lo, 'zz');
      generated.push(k);
      lo = k;
    }
    for (const k of generated) {
      expect(isTerminal(k), `"${k}" is terminal`).toBe(false);
    }
  });

  it('survives repeated PREPENDS to the top of a column', () => {
    let hi = 'z';
    for (let i = 0; i < 100; i++) {
      const k = keyBetween(null, hi);
      expect(k < hi).toBe(true);
      expect(isTerminal(k)).toBe(false);
      hi = k;
    }
  });

  it('ignores junk characters in a hand-written key instead of dying', () => {
    expect(() => keyBetween('a0', 'a5')).not.toThrow();
    expect(keyBetween('a0', 'a5').length).toBeGreaterThan(0);
  });

  it('computes the drop key from the true neighbours, excluding the moving card', () => {
    const column = [
      task({ id: 'a', orderKey: 'a' }),
      task({ id: 'b', orderKey: 'b' }),
      task({ id: 'c', orderKey: 'c' }),
    ];
    // move 'a' to the middle: it must measure against b and c, not itself
    const k = keyForDrop(column, 1, 'a');
    expect(k > 'b').toBe(true);
    expect(k < 'c').toBe(true);
  });

  it('clamps an out-of-range index instead of producing nonsense', () => {
    const column = [task({ id: 'a', orderKey: 'a' })];
    expect(keyForDrop(column, 99).length).toBeGreaterThan(0);
    expect(keyForDrop(column, -5).length).toBeGreaterThan(0);
  });
});

describe('what a drop actually writes', () => {
  it('moving to Done sets status and clears the block', () => {
    expect(updateForDrop(task({ blockedReason: 'x' }), 'done', 'a0')).toEqual({
      status: 'done',
      orderKey: 'a0',
      blockedReason: null,
    });
  });

  it('moving to Later sets status, not a block', () => {
    expect(updateForDrop(task(), 'later', 'a0')).toEqual({
      status: 'later',
      orderKey: 'a0',
      blockedReason: null,
    });
  });

  it('moving INTO Waiting demands a reason — blocked-ness is never invented', () => {
    expect(updateForDrop(task(), 'waiting', 'a0')).toEqual({ orderKey: 'a0', needsReason: true });
  });

  it('reordering WITHIN Waiting keeps the existing reason', () => {
    expect(updateForDrop(task({ blockedReason: 'waiting on Dana' }), 'waiting', 'a1')).toEqual({
      orderKey: 'a1',
    });
  });

  it('moving OUT of Waiting unblocks the task', () => {
    expect(updateForDrop(task({ blockedReason: 'x' }), 'now', 'a0')).toEqual({
      status: 'now',
      orderKey: 'a0',
      blockedReason: null,
    });
  });
});

describe('due dates', () => {
  it('flags an overdue task, but never a done one', () => {
    expect(isOverdue(task({ dueDate: '2026-07-01' }), '2026-07-14')).toBe(true);
    expect(isOverdue(task({ dueDate: '2026-08-01' }), '2026-07-14')).toBe(false);
    expect(isOverdue(task({ dueDate: '2026-07-01', status: 'done' }), '2026-07-14')).toBe(false);
    expect(isOverdue(task({ dueDate: null }), '2026-07-14')).toBe(false);
  });
});
