/**
 * Scope-overlap detection for parallel lanes (ADR-0048). Two lanes confined to
 * their own per-lane jails (ADR-0039) can never conflict — their paths are disjoint
 * by construction. Overlap can only arise when the operator NAMES shared paths, so
 * detecting it lets the Approval Constitution gate that deliberate act.
 *
 * Pure, deterministic path-prefix logic (mirrors `isWithinRoots` in the lanes
 * runner). No filesystem access — the paths are already-resolved mandate scopes.
 */

const norm = (p: string): string => p.replace(/\/+$/, '');

/** Is `path` equal to, or nested under, `root`? */
export function isWithin(path: string, root: string): boolean {
  const p = norm(path);
  const r = norm(root);
  return p === r || p.startsWith(`${r}/`);
}

/** Do any paths in A and B overlap (either contains or equals the other)? */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((pa) => b.some((pb) => isWithin(pa, pb) || isWithin(pb, pa)));
}

/** The ids of active lanes whose scope overlaps a candidate scope. */
export function activeScopeConflicts(
  candidate: readonly string[],
  active: readonly { laneId: string; paths: readonly string[] }[],
): string[] {
  if (candidate.length === 0) return [];
  return active.filter((l) => scopesOverlap(candidate, l.paths)).map((l) => l.laneId);
}
