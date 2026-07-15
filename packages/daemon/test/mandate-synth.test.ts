import type { DecisionRow, MemoryEntryRow, ProjectBriefRow } from '@amrita/store';
import { describe, expect, it } from 'vitest';
import { buildMandateFromChat } from '../src/mandate-synth.ts';

const LANE = '01KXH15R9K1W1MM86W52WVWABH'; // a valid ULID
const brief = (o: Partial<ProjectBriefRow>): ProjectBriefRow =>
  ({ goal: 'Ship the store', finishLine: 'green CI', ...o }) as ProjectBriefRow;

describe('buildMandateFromChat — a chat request → a strict LaneMandate (ADR-0048)', () => {
  it('the request leads, the charter grounds it, and it parses strictly', () => {
    const m = buildMandateFromChat({
      laneId: LANE,
      requestText: 'add a discount code field to checkout',
      brief: brief({}),
      memory: [{ content: 'the app uses Stripe' } as MemoryEntryRow],
      decisions: [{ text: 'switched to the new payment SDK' } as DecisionRow],
      budget: { maxMinutes: 20 },
    });
    expect(m.laneId).toBe(LANE);
    expect(m.goal).toContain('discount code');
    expect(m.goal).toContain('Project goal: Ship the store');
    expect(m.goal).toContain('Done means: green CI');
    expect(m.contextPack.memory).toEqual(['the app uses Stripe']);
    expect(m.contextPack.decisions).toEqual(['switched to the new payment SDK']);
    expect(m.scope.network).toBe('none');
    expect(m.scope.paths).toBeUndefined(); // startLane synthesizes the jailed workspace
    expect(m.approvals).toBe('forward'); // keeps the human-disposes gate
    expect(m.budget.maxMinutes).toBe(20);
  });

  it('no brief → the goal is just the request', () => {
    const m = buildMandateFromChat({
      laneId: LANE,
      requestText: 'fix the flaky checkout test',
      brief: null,
      memory: [],
      decisions: [],
      budget: {},
    });
    expect(m.goal).toBe('fix the flaky checkout test');
  });

  it('bounds the goal and context to the schema limits (decisions take the recent tail)', () => {
    const m = buildMandateFromChat({
      laneId: LANE,
      requestText: 'x'.repeat(5000),
      brief: null,
      memory: Array.from({ length: 20 }, (_, i) => ({ content: `m${i}` }) as MemoryEntryRow),
      decisions: Array.from({ length: 20 }, (_, i) => ({ text: `d${i}` }) as DecisionRow),
      budget: {},
    });
    expect(m.goal.length).toBe(4000);
    expect(m.contextPack.memory).toHaveLength(6);
    expect(m.contextPack.decisions).toHaveLength(6);
    expect(m.contextPack.decisions).toContain('d19'); // the newest, not the oldest
  });
});
