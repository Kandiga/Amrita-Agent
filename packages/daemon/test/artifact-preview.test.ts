import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PREVIEW_CSP,
  ArtifactPreviewStore,
  MAX_ARTIFACT_BYTES,
} from '../src/artifact-preview.ts';

/**
 * ADR-0057 finding 3: the artifact preview store backs the dedicated,
 * self-CSP'd route that isolates generated HTML from the app's authority.
 */

function seq(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe('ArtifactPreviewStore', () => {
  it('stores HTML and reads it back only with the exact id + ticket', () => {
    const s = new ArtifactPreviewStore({ genId: seq('id'), genTicket: seq('tk') });
    const ref = s.put('<h1>hi</h1>', 1_000);
    expect(ref.id).toBe('id1');
    expect(ref.ticket).toBe('tk1');
    expect(s.read('id1', 'tk1', 2_000)).toBe('<h1>hi</h1>');
    expect(s.read('id1', 'WRONG', 2_000)).toBeNull(); // bad ticket
    expect(s.read('nope', 'tk1', 2_000)).toBeNull(); // bad id
  });

  it('expires after the TTL', () => {
    const s = new ArtifactPreviewStore({ ttlMs: 1_000, genId: seq('id'), genTicket: seq('tk') });
    s.put('x', 0);
    expect(s.read('id1', 'tk1', 999)).toBe('x');
    expect(s.read('id1', 'tk1', 1_001)).toBeNull();
    expect(s.size(1_001)).toBe(0); // pruned
  });

  it('LRU-caps entries so a live stream cannot grow memory without bound', () => {
    const s = new ArtifactPreviewStore({ maxEntries: 3, genId: seq('id'), genTicket: seq('tk') });
    s.put('a', 0); // id1
    s.put('b', 0); // id2
    s.put('c', 0); // id3
    s.put('d', 0); // id4 → evicts id1
    expect(s.read('id1', 'tk1', 1)).toBeNull(); // oldest gone
    expect(s.read('id4', 'tk4', 1)).toBe('d');
    expect(s.size(1)).toBe(3);
  });

  it('refuses oversize HTML (spill to a lane file instead)', () => {
    const s = new ArtifactPreviewStore();
    const big = 'x'.repeat(MAX_ARTIFACT_BYTES + 1);
    expect(() => s.put(big, 0)).toThrow(/limit/);
  });

  it('the served CSP has connect-src none and inline scripts (isolated + runnable)', () => {
    expect(ARTIFACT_PREVIEW_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("script-src 'unsafe-inline'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("frame-ancestors 'self'");
  });
});
