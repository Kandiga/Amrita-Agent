import { describe, expect, it } from 'vitest';
import { type CapsuleLane, buildConclusionCapsule } from '../src/conclusion-capsule.ts';

const lane = (o: Partial<CapsuleLane>): CapsuleLane => ({
  laneId: 'L1',
  kind: 'claude-code',
  status: 'running',
  goal: 'build the checkout',
  decisions: [],
  followUps: [],
  tasks: [],
  ...o,
});

const CONV = '01KXH15R9K1W1MM86W52WVWABH';
const base = { conversationId: CONV, lanes: [], inbox: [], approvals: [] };

describe('buildConclusionCapsule — the derived view Amrita shows instead of code (ADR-0048)', () => {
  it('nothing running → idle, all sections empty', () => {
    const c = buildConclusionCapsule(base);
    expect(c.status).toBe('idle');
    expect(c.progress).toHaveLength(0);
    expect(c.nextActions).toHaveLength(0);
  });

  it('a running lane → running, with provenance to the lane', () => {
    const c = buildConclusionCapsule({ ...base, lanes: [lane({ status: 'running' })] });
    expect(c.status).toBe('running');
    expect(c.progress).toHaveLength(1);
    expect(c.progress[0]?.provenance[0]).toMatchObject({ kind: 'lane', ref: 'L1' });
  });

  it('a pending approval → blocked, and it is both a conflict and a next action', () => {
    const c = buildConclusionCapsule({
      ...base,
      lanes: [lane({})],
      approvals: [{ approvalId: 'A1', action: 'lane.run-real', laneId: 'L1' }],
    });
    expect(c.status).toBe('blocked');
    expect(c.conflicts[0]?.provenance[0]).toMatchObject({ kind: 'approval', ref: 'A1' });
    expect(c.nextActions.some((n) => n.text.includes('approve or deny'))).toBe(true);
  });

  it('a completed lane surfaces its decisions and a validation line', () => {
    const c = buildConclusionCapsule({
      ...base,
      lanes: [
        lane({
          status: 'completed',
          exit: 'done',
          summary: 'shipped the discount field',
          decisions: ['switched to the new SDK'],
        }),
      ],
    });
    expect(c.status).toBe('done');
    expect(c.decisions[0]?.text).toBe('switched to the new SDK');
    expect(c.validation[0]?.text).toContain('shipped the discount field');
  });

  it('a partial/aborted lane becomes a risk', () => {
    const c = buildConclusionCapsule({
      ...base,
      lanes: [lane({ status: 'completed', exit: 'partial', summary: 'ran out of budget' })],
    });
    expect(c.risks[0]?.text).toContain('partial');
  });

  it('lane-origin inbox proposals become triage next actions', () => {
    const c = buildConclusionCapsule({
      ...base,
      inbox: [{ id: 'I1', text: 'add a regression test', suggestedKind: 'task' }],
    });
    expect(c.nextActions[0]?.text).toContain('add a regression test');
    expect(c.nextActions[0]?.provenance[0]).toMatchObject({ kind: 'inbox', ref: 'I1' });
  });
});
