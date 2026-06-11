import { describe, expect, it } from 'vitest';
import { type CompanionInputs, nextActions } from '../src/companion.ts';
import type { LaneView } from '../src/lanes-state.ts';

function base(over: Partial<CompanionInputs> = {}): CompanionInputs {
  return {
    doctor: { sections: [] },
    brief: { goal: 'ship it' },
    questions: [],
    risks: [],
    milestones: [],
    tasks: [],
    decisions: [],
    lanes: [],
    conversationId: 'C1',
    ...over,
  };
}

function lane(over: Partial<LaneView> & { id: string; status: LaneView['status'] }): LaneView {
  return { kind: 'claude-code', progress: [], ...over };
}

describe('companion nextActions v2 (pure, rule-based)', () => {
  it('suggests brief, first task and first decision on a fresh project', () => {
    const actions = nextActions(base({ brief: null }));
    expect(actions.map((a) => a.id)).toEqual(['brief-missing', 'task-first', 'decision-first']);
    expect(actions.every((a) => a.urgency === 'suggestion')).toBe(true);
  });

  it('a doctor FAIL becomes the top blocker, above everything else', () => {
    const actions = nextActions(
      base({
        doctor: {
          sections: [
            { title: 'providers', checks: [{ label: 'anthropic provider', status: 'fail' }] },
          ],
        },
        tasks: [{ id: 'T1', title: 'ship', status: 'now' }],
      }),
    );
    expect(actions[0]).toMatchObject({ urgency: 'blocker', label: 'Fix runtime setup' });
    // doctor WARNS deliberately do not generate actions (needs-setup is normal)
    const warned = nextActions(
      base({
        doctor: {
          sections: [{ title: 'channels', checks: [{ label: 'telegram', status: 'warn' }] }],
        },
      }),
    );
    expect(warned.some((a) => a.urgency === 'blocker')).toBe(false);
  });

  it('an open HIGH risk demands attention; low/resolved risks do not', () => {
    const actions = nextActions(
      base({
        risks: [
          { id: 'R1', text: 'data loss', status: 'open', severity: 'high' },
          { id: 'R2', text: 'minor', status: 'open', severity: 'low' },
          { id: 'R3', text: 'was bad', status: 'resolved', severity: 'high' },
        ],
      }),
    );
    expect(actions[0]).toMatchObject({ id: 'risk:R1', urgency: 'attention' });
    expect(actions.filter((a) => a.id.startsWith('risk:'))).toHaveLength(1);
  });

  it('open questions surface with a count and the oldest text', () => {
    const actions = nextActions(
      base({
        questions: [
          { id: 'Q1', text: 'which auth?', status: 'open' },
          { id: 'Q2', text: 'which db?', status: 'open' },
          { id: 'Q3', text: 'done', status: 'resolved' },
        ],
      }),
    );
    const q = actions.find((a) => a.id === 'question:Q1');
    expect(q?.label).toBe('Resolve 2 open questions');
    expect(q?.detail).toContain('which auth?');
  });

  it('an active milestone with no open tasks asks for planning', () => {
    const actions = nextActions(
      base({
        milestones: [
          { id: 'M1', title: 'Alpha', status: 'active' },
          { id: 'M2', title: 'Later', status: 'planned' },
        ],
        tasks: [{ id: 'T1', title: 'done already', status: 'done', milestoneId: 'M1' }],
        decisions: [{ id: 'D1' }],
      }),
    );
    expect(actions.find((a) => a.id === 'milestone-plan:M1')?.detail).toContain('Alpha');
    // with an open task linked, the nudge disappears
    const planned = nextActions(
      base({
        milestones: [{ id: 'M1', title: 'Alpha', status: 'active' }],
        tasks: [{ id: 'T1', title: 'build', status: 'now', milestoneId: 'M1' }],
        decisions: [{ id: 'D1' }],
      }),
    );
    expect(planned.some((a) => a.id.startsWith('milestone-plan'))).toBe(false);
  });

  it('an active lane outranks suggestions; a finished lane asks for review', () => {
    const running = nextActions(
      base({ lanes: [lane({ id: 'L1', status: 'running', goal: 'tidy repo' })] }),
    );
    expect(running[0]).toMatchObject({ urgency: 'attention', label: 'A lane is working' });

    const finished = nextActions(
      base({ lanes: [lane({ id: 'L2', status: 'completed', exit: 'done', summary: 'all tidy' })] }),
    );
    expect(finished[0]).toMatchObject({ urgency: 'attention', label: 'Review the lane report' });
  });

  it('points at the top open task and counts the rest; done/dropped are not "open"', () => {
    const actions = nextActions(
      base({
        tasks: [
          { id: 'T1', title: 'write spec', status: 'now' },
          { id: 'T2', title: 'later thing', status: 'later' },
          { id: 'T3', title: 'old', status: 'done' },
        ],
        decisions: [{ id: 'D1' }],
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]?.detail).toBe('"write spec" is open (+1 more).');
  });

  it('suggests no knowledge writes without an open conversation', () => {
    expect(nextActions(base({ brief: null, conversationId: '' }))).toEqual([]);
  });

  it('returns an empty list when state is genuinely healthy and quiet', () => {
    const actions = nextActions(
      base({
        tasks: [{ id: 'T1', title: 'x', status: 'done' }],
        decisions: [{ id: 'D1' }],
        doctor: { sections: [{ title: 'store', checks: [{ label: 'rows', status: 'ok' }] }] },
      }),
    );
    expect(actions).toEqual([]);
  });
});
