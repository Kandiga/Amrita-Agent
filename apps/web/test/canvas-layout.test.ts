import { describe, expect, it } from 'vitest';
import {
  CARD_MIN_H,
  CARD_MIN_W,
  type CanvasLayout,
  moveCard,
  raise,
  reconcile,
  resizeCard,
  toggleMinimized,
  topZ,
} from '../src/canvas-layout.ts';

describe('free-canvas layout (Live Canvas Phase 1)', () => {
  it('reconcile places new cards cascaded, each on top', () => {
    const l = reconcile({}, ['a', 'b', 'c']);
    expect(Object.keys(l)).toEqual(['a', 'b', 'c']);
    expect(l.b?.x).toBeGreaterThan(l.a?.x ?? 0); // cascaded, not stacked
    expect((l.c?.z ?? 0) > (l.a?.z ?? 0)).toBe(true); // newest on top
  });

  it('reconcile keeps existing cards put and drops removed ones', () => {
    const l1 = reconcile({}, ['a', 'b']);
    const moved = moveCard(l1, 'a', 200, 120);
    const l2 = reconcile(moved, ['a', 'c']); // b removed, c added
    expect(l2.a?.x).toBe(moved.a?.x); // a's moved position preserved
    expect(l2.b).toBeUndefined(); // removed
    expect(l2.c).toBeDefined(); // added
  });

  it('raise puts a card on top and is a no-op when already there', () => {
    const l = reconcile({}, ['a', 'b']); // b on top
    const r = raise(l, 'a');
    expect(topZ(r)).toBe((r.a?.z ?? 0) + 1);
    expect(r.a?.z).toBeGreaterThan(r.b?.z ?? 0);
    expect(raise(r, 'a')).toBe(r); // already on top → same reference
  });

  it('move clamps to the origin (a card cannot leave the top-left)', () => {
    const l = reconcile({}, ['a']);
    const m = moveCard(l, 'a', -9999, -9999);
    expect(m.a?.x).toBe(0);
    expect(m.a?.y).toBe(0);
  });

  it('resize clamps to the minimum size', () => {
    const l = reconcile({}, ['a']);
    const r = resizeCard(l, 'a', -9999, -9999);
    expect(r.a?.w).toBe(CARD_MIN_W);
    expect(r.a?.h).toBe(CARD_MIN_H);
  });

  it('toggleMinimized flips and is reversible', () => {
    const l = reconcile({}, ['a']);
    expect(l.a?.minimized).toBe(false);
    const min = toggleMinimized(l, 'a');
    expect(min.a?.minimized).toBe(true);
    expect(toggleMinimized(min, 'a').a?.minimized).toBe(false);
  });

  it('unknown ids are safe no-ops', () => {
    const l: CanvasLayout = reconcile({}, ['a']);
    expect(moveCard(l, 'ghost', 5, 5)).toBe(l);
    expect(resizeCard(l, 'ghost', 5, 5)).toBe(l);
    expect(raise(l, 'ghost')).toBe(l);
  });
});
