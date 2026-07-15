import type { MilestoneRowWire, RiskRowWire, TaskRowWire } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import { buildStatusStrip, daysBetween } from '../src/health.ts';

const TS = '2026-07-14T10:00:00.000Z';
const TODAY = '2026-07-14';

const task = (o: Partial<TaskRowWire> = {}): TaskRowWire =>
  ({
    id: 't1',
    projectId: 'p1',
    conversationId: null,
    sourceMessageId: null,
    laneId: null,
    milestoneId: null,
    status: 'now',
    title: 'File the permit',
    body: null,
    owner: null,
    dueDate: null,
    priority: null,
    orderKey: null,
    blockedReason: null,
    certainty: null,
    phaseId: null,
    version: 0,
    derivedFrom: [],
    externalRef: null,
    createdAt: TS,
    updatedAt: TS,
    ...o,
  }) as TaskRowWire;

const milestone = (o: Partial<MilestoneRowWire> = {}): MilestoneRowWire =>
  ({
    id: 'm1',
    projectId: 'p1',
    title: 'Permits secured',
    description: null,
    status: 'active',
    targetDate: '2026-09-01',
    createdAt: TS,
    updatedAt: TS,
    ...o,
  }) as MilestoneRowWire;

const risk = (o: Partial<RiskRowWire> = {}): RiskRowWire =>
  ({
    id: 'r1',
    projectId: 'p1',
    conversationId: null,
    sourceMessageId: null,
    text: 'rain on the day',
    severity: 'high',
    status: 'open',
    resolution: null,
    resolvedByDecisionId: null,
    dropReason: null,
    certainty: null,
    createdAt: TS,
    updatedAt: TS,
    ...o,
  }) as RiskRowWire;

const strip = (o: {
  activated?: boolean;
  tasks?: TaskRowWire[];
  milestones?: MilestoneRowWire[];
  risks?: RiskRowWire[];
}) =>
  buildStatusStrip({
    activated: o.activated ?? true,
    tasks: o.tasks ?? [],
    milestones: o.milestones ?? [],
    risks: o.risks ?? [],
    today: TODAY,
  });

describe('the status strip (ADR-0045)', () => {
  it('counts days to the next milestone', () => {
    expect(daysBetween(TODAY, '2026-07-21')).toBe(7);
    expect(daysBetween(TODAY, '2026-07-01')).toBe(-13);
  });

  it('a project that has not started says so, and nothing else', () => {
    expect(strip({ activated: false }).health).toBe('not-started');
  });

  it('nothing wrong → on track, and it says so plainly', () => {
    const s = strip({ tasks: [task()], milestones: [milestone()] });
    expect(s.health).toBe('on-track');
    expect(s.topBlocker).toBeNull();
    expect(s.nextMilestone?.title).toBe('Permits secured');
    expect(s.nextMilestone?.daysLeft).toBe(49);
  });

  it('a blocked task makes the project AT RISK, and names what it is waiting on', () => {
    const s = strip({ tasks: [task({ blockedReason: 'the arts council has not replied' })] });
    expect(s.health).toBe('at-risk');
    expect(s.topBlocker).toEqual({
      text: 'the arts council has not replied',
      kind: 'blocked-task',
    });
    expect(s.counts.blocked).toBe(1);
  });

  it('an OVERDUE task beats a blocked one — it is the more urgent truth', () => {
    const s = strip({
      tasks: [
        task({ id: 'a', blockedReason: 'waiting on Dana' }),
        task({ id: 'b', title: 'Pay the deposit', dueDate: '2026-07-01' }),
      ],
    });
    expect(s.health).toBe('blocked');
    expect(s.topBlocker).toEqual({ text: 'Pay the deposit is overdue', kind: 'overdue' });
    expect(s.counts.overdue).toBe(1);
  });

  it('a high open risk is the blocker when nothing else is', () => {
    const s = strip({ tasks: [task()], risks: [risk()] });
    expect(s.health).toBe('at-risk');
    expect(s.topBlocker).toEqual({ text: 'rain on the day', kind: 'open-risk' });
  });

  it('ignores a resolved risk and a done milestone', () => {
    const s = strip({
      tasks: [task()],
      risks: [risk({ status: 'resolved' })],
      milestones: [milestone({ status: 'done' })],
    });
    expect(s.health).toBe('on-track');
    expect(s.nextMilestone).toBeNull();
  });

  it('a milestone with no date is a wish, not a deadline', () => {
    expect(strip({ milestones: [milestone({ targetDate: null })] }).nextMilestone).toBeNull();
  });

  it('picks the SOONEST milestone, not the first one entered', () => {
    const s = strip({
      milestones: [
        milestone({ id: 'm1', title: 'Later', targetDate: '2026-10-01' }),
        milestone({ id: 'm2', title: 'Sooner', targetDate: '2026-08-01' }),
      ],
    });
    expect(s.nextMilestone?.title).toBe('Sooner');
  });

  it('a done task is not "open"', () => {
    const s = strip({ tasks: [task({ status: 'done' }), task({ id: 'b' })] });
    expect(s.counts.open).toBe(1);
  });
});
