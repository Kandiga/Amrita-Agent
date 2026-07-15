import { describe, expect, it } from 'vitest';
import {
  constraintLabel,
  formatConstraints,
  formatDecisionRights,
  parseConstraints,
  parseDecisionRights,
} from '../src/charter.ts';

describe('charter constraints (ADR-0044)', () => {
  it('parses kind, text and the fixed-vs-negotiable flag', () => {
    expect(parseConstraints('budget: $15K net, no overrun (hard)')).toEqual([
      { kind: 'budget', text: '$15K net, no overrun', hard: true },
    ]);
  });

  it('defaults to NEGOTIABLE — a constraint is only fixed if you say so', () => {
    expect(parseConstraints('resource: one full-time organizer')).toEqual([
      { kind: 'resource', text: 'one full-time organizer', hard: false },
    ]);
  });

  it('accepts a bare line as a policy constraint', () => {
    expect(parseConstraints('the mayor must be invited')).toEqual([
      { kind: 'policy', text: 'the mayor must be invited', hard: false },
    ]);
  });

  it('does not mistake an unknown prefix for a kind', () => {
    // "vendors" is not a kind — the whole line is the text, colon and all.
    expect(parseConstraints('vendors: at least 40 booths')).toEqual([
      { kind: 'policy', text: 'vendors: at least 40 booths', hard: false },
    ]);
  });

  it('accepts the other fixed markers', () => {
    expect(parseConstraints('date: October 17 (fixed)')[0]?.hard).toBe(true);
    expect(parseConstraints('date: October 17 (non-negotiable)')[0]?.hard).toBe(true);
  });

  it('skips blank lines', () => {
    expect(parseConstraints('\n  \nbudget: $1 (hard)\n\n')).toHaveLength(1);
  });

  it('round-trips through format → parse', () => {
    const constraints = [
      { kind: 'budget' as const, text: '$15K net', hard: true },
      { kind: 'resource' as const, text: 'one organizer', hard: false },
    ];
    expect(parseConstraints(formatConstraints(constraints))).toEqual(constraints);
  });

  it('labels a fixed constraint distinctly', () => {
    expect(constraintLabel({ kind: 'budget', text: '$15K', hard: true })).toBe('$15K · fixed');
    expect(constraintLabel({ kind: 'budget', text: '$15K', hard: false })).toBe('$15K');
  });
});

describe('charter decision rights (ADR-0044)', () => {
  it('parses area → approver with an arrow', () => {
    expect(parseDecisionRights('vendor list -> the arts council')).toEqual([
      { area: 'vendor list', approver: 'the arts council' },
    ]);
    expect(parseDecisionRights('vendor list → the arts council')).toEqual([
      { area: 'vendor list', approver: 'the arts council' },
    ]);
  });

  it('falls back to a colon', () => {
    expect(parseDecisionRights('spend: Casey')).toEqual([{ area: 'spend', approver: 'Casey' }]);
  });

  it('prefers the arrow, so an area may contain a colon', () => {
    expect(parseDecisionRights('spend over $1K: anything -> Casey')).toEqual([
      { area: 'spend over $1K: anything', approver: 'Casey' },
    ]);
  });

  it('drops a half-written line rather than inventing an approver', () => {
    expect(parseDecisionRights('vendor list ->')).toEqual([]);
    expect(parseDecisionRights('-> Casey')).toEqual([]);
    expect(parseDecisionRights('no separator here')).toEqual([]);
  });

  it('round-trips through format → parse', () => {
    const rights = [{ area: 'vendor list', approver: 'the arts council' }];
    expect(parseDecisionRights(formatDecisionRights(rights))).toEqual(rights);
  });
});
