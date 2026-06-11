import { describe, expect, it } from 'vitest';
import { type CompanionInputs, nextActions } from '../src/companion.ts';
import type { LaneView } from '../src/lanes-state.ts';

function base(over: Partial<CompanionInputs> = {}): CompanionInputs {
  return {
    doctor: { sections: [] },
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

describe('companion nextActions (pure, rule-based)', () => {
  it('suggests first task and first decision on a fresh project', () => {
    const actions = nextActions(base());
    expect(actions.map((a) => a.id)).toEqual(['task-first', 'decision-first']);
    expect(actions.every((a) => a.urgency === 'suggestion')).toBe(true);
  });

  it('a doctor FAIL becomes the top blocker, above everything else', () => {
    const actions = nextActions(
      base({
        doctor: {
          sections: [
            {
              title: 'providers',
              checks: [{ label: 'anthropic provider', status: 'fail' }],
            },
          ],
        },
        tasks: [{ id: 'T1', title: 'ship', status: 'now' }],
      }),
    );
    expect(actions[0]).toMatchObject({ urgency: 'blocker', label: 'Fix runtime setup' });
    expect(actions[0]?.detail).toContain('anthropic provider');
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

  it('an active lane outranks suggestions; a finished lane asks for review', () => {
    const running = nextActions(
      base({ lanes: [lane({ id: 'L1', status: 'running', goal: 'tidy repo' })] }),
    );
    expect(running[0]).toMatchObject({ urgency: 'attention', label: 'A lane is working' });
    expect(running[0]?.detail).toContain('tidy repo');

    const finished = nextActions(
      base({
        lanes: [lane({ id: 'L2', status: 'completed', exit: 'done', summary: 'all tidy' })],
      }),
    );
    expect(finished[0]).toMatchObject({ urgency: 'attention', label: 'Review the lane report' });
    expect(finished[0]?.detail).toContain('all tidy');
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
    const actions = nextActions(base({ conversationId: '' }));
    expect(actions).toEqual([]); // honest empty — nothing actionable
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
