import type { ProjectBriefRow } from '@amrita/store';
import { describe, expect, it } from 'vitest';
import { auditCharter, readyToActivate } from '../src/charter-audit.ts';

const TS = '2026-07-14T10:00:00.000Z';

function brief(over: Partial<ProjectBriefRow> = {}): ProjectBriefRow {
  return {
    projectId: 'p1',
    goal: 'Run the Unity Festival',
    audience: null,
    successCriteria: ['500 attendees'],
    scope: [],
    noScope: [],
    finishLine: 'the festival happens and books at 15K net',
    constraints: [{ kind: 'budget', text: '15K net', hard: true }],
    decisionRights: [{ area: 'spend', approver: 'Casey' }],
    certainty: {},
    version: 0,
    sourceMessageId: null,
    createdAt: TS,
    updatedAt: TS,
    ...over,
  } as ProjectBriefRow;
}

const audit = (b: ProjectBriefRow | null) =>
  auditCharter({ brief: b, tasks: [], risks: [], questions: [] });

describe('the charter audit — Amrita as a manager, not an assistant (ADR-0045)', () => {
  it('a complete charter has nothing to say', () => {
    expect(audit(brief())).toEqual([]);
  });

  it('no brief at all → ask for the goal', () => {
    const f = audit(null);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'missing', field: 'goal', severity: 'high' });
  });

  // ── חוסר ───────────────────────────────────────────────────────────────────

  it('no finish line → "done" is a matter of opinion', () => {
    const f = audit(brief({ finishLine: null }));
    expect(f.some((x) => x.kind === 'missing' && x.field === 'finishLine')).toBe(true);
  });

  it('"חסר בעל תפקיד" — there is a budget but nobody may approve anything', () => {
    const f = audit(brief({ decisionRights: [] }));
    const found = f.find((x) => x.field === 'decisionRights');
    expect(found?.kind).toBe('missing');
    expect(found?.severity).toBe('high');
    expect(found?.detail).toMatch(/budget but nobody is authorised/i);
    expect(found?.ask).toMatch(/who signs off/i);
  });

  it('there is a budget, but no decision right actually covers spending', () => {
    const f = audit(brief({ decisionRights: [{ area: 'vendor list', approver: 'the council' }] }));
    expect(
      f.some(
        (x) => x.field === 'decisionRights' && /no decision right covers spending/i.test(x.detail),
      ),
    ).toBe(true);
  });

  // ── סתירה ──────────────────────────────────────────────────────────────────

  it('"התנגשות בין שני אישורים" — two people approve the same area', () => {
    const f = audit(
      brief({
        decisionRights: [
          { area: 'spend', approver: 'Casey' },
          { area: 'Spend', approver: 'the arts council' }, // same area, different case
        ],
      }),
    );
    const found = f.find((x) => x.kind === 'contradiction' && x.field === 'decisionRights');
    expect(found).toBeDefined();
    expect(found?.severity).toBe('high');
    expect(found?.detail).toMatch(/Competing veto power/i);
  });

  it('two HARD dates — one of them is not actually fixed', () => {
    const f = audit(
      brief({
        constraints: [
          { kind: 'date', text: 'third Saturday of October', hard: true },
          { kind: 'date', text: 'before the school term starts', hard: true },
          { kind: 'budget', text: '15K', hard: true },
        ],
      }),
    );
    const found = f.find((x) => x.kind === 'contradiction' && x.field === 'constraints');
    expect(found?.severity).toBe('high');
    expect(found?.detail).toMatch(/marked as fixed/i);
  });

  it('everything negotiable ⇒ nothing is really a constraint', () => {
    const f = audit(brief({ constraints: [{ kind: 'budget', text: '15K', hard: false }] }));
    expect(
      f.some(
        (x) =>
          x.kind === 'contradiction' && /every constraint is marked negotiable/i.test(x.detail),
      ),
    ).toBe(true);
  });

  it('the same thing listed as both in scope and out of scope', () => {
    const f = audit(brief({ scope: ['the after-party'], noScope: ['The After-Party'] }));
    expect(f.some((x) => x.kind === 'contradiction' && x.field === 'scope')).toBe(true);
  });

  // ── ודאות ──────────────────────────────────────────────────────────────────

  it('flags a GUESS sitting in the charter as though you had said it', () => {
    const f = audit(brief({ certainty: { finishLine: 'inferred' } }));
    const found = f.find((x) => x.kind === 'unconfirmed' && x.field === 'finishLine');
    expect(found?.severity).toBe('high');
    expect(found?.detail).toMatch(/hypothesis, not a fact/i);
  });

  it('does NOT flag something you actually stated', () => {
    const f = audit(brief({ certainty: { finishLine: 'stated', goal: 'documented' } }));
    expect(f.filter((x) => x.kind === 'unconfirmed')).toHaveLength(0);
  });

  it('orders the most severe finding first', () => {
    const f = audit(brief({ finishLine: null, successCriteria: [] }));
    expect(f[0]?.severity).toBe('high');
  });
});

describe('readyToActivate — refuse to conjure a board out of nothing', () => {
  it('needs a goal, a finish line and at least one constraint', () => {
    expect(readyToActivate(null)).toBe(false);
    expect(readyToActivate(brief({ finishLine: null }))).toBe(false);
    expect(readyToActivate(brief({ constraints: [] }))).toBe(false);
    expect(readyToActivate(brief())).toBe(true);
  });
});
