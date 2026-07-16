import { describe, expect, it } from 'vitest';
import { criterionLabel, evidenceView, parseCriteria } from '../src/task-evidence.ts';

/** ADR-0055 — the evidence badge derives from raw JSON columns, defensively. */

describe('task evidence view', () => {
  it('parses criteria and counts machine checks', () => {
    const json = JSON.stringify([
      { kind: 'command', run: 'pnpm test' },
      { kind: 'file', path: 'dist/index.html' },
      { kind: 'manual', text: 'looks right' },
    ]);
    const v = evidenceView(json, null);
    expect(v.criteria).toHaveLength(3);
    expect(v.machineCount).toBe(2);
    expect(v.verified).toBeNull();
  });

  it('summarizes a verification run (pass and fail)', () => {
    const verification = JSON.stringify({
      at: '2026-07-16T00:00:00.000Z',
      passed: false,
      results: [{ ok: true }, { ok: false }],
    });
    const v = evidenceView('[]', verification);
    expect(v.verified).toEqual({
      passed: false,
      at: '2026-07-16T00:00:00.000Z',
      okCount: 1,
      total: 2,
    });
  });

  it('malformed JSON never crashes the panel', () => {
    expect(parseCriteria('{oops')).toEqual([]);
    expect(evidenceView('{oops', '{oops').verified).toBeNull();
  });

  it('labels are one-line and kind-prefixed', () => {
    expect(criterionLabel({ kind: 'file', path: 'a/b' })).toBe('file: a/b');
    expect(criterionLabel({ kind: 'command', run: 'pnpm t' })).toBe('run: pnpm t');
    expect(criterionLabel({ kind: 'manual', text: 'x' })).toBe('manual: x');
  });
});
