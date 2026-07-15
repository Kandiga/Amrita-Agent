import { describe, expect, it } from 'vitest';
import { activeScopeConflicts, isWithin, scopesOverlap } from '../src/lane-scope.ts';

describe('lane-scope — overlap detection (ADR-0048)', () => {
  it('isWithin: nested and equal paths, with no false-prefix matches', () => {
    expect(isWithin('/ws/L1/src', '/ws/L1')).toBe(true);
    expect(isWithin('/ws/L1', '/ws/L1')).toBe(true);
    expect(isWithin('/ws/L2', '/ws/L1')).toBe(false);
    expect(isWithin('/ws/L10', '/ws/L1')).toBe(false); // "L10" is not under "L1"
  });

  it('disjoint per-lane jails never overlap (the default, conflict-free case)', () => {
    expect(scopesOverlap(['/ws/L1'], ['/ws/L2'])).toBe(false);
  });

  it('a shared root overlaps a sub-path (either direction)', () => {
    expect(scopesOverlap(['/repo'], ['/repo/src'])).toBe(true);
    expect(scopesOverlap(['/repo/src'], ['/repo'])).toBe(true);
  });

  it('activeScopeConflicts returns exactly the conflicting lane ids', () => {
    const active = [
      { laneId: 'A', paths: ['/repo/src'] },
      { laneId: 'B', paths: ['/ws/L9'] },
    ];
    expect(activeScopeConflicts(['/repo/src/x'], active)).toEqual(['A']);
    expect(activeScopeConflicts(['/ws/L1'], active)).toEqual([]);
    expect(activeScopeConflicts([], active)).toEqual([]); // a jailed lane names no shared paths
  });
});
