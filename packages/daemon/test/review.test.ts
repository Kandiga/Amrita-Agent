import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { STALE_DAYS, buildReviewPacket, isoWeek, renderReviewPacket } from '../src/review.ts';
import {
  DEFAULT_REVIEW_JOB,
  SCHEDULER_JOBS_SETTING,
  Scheduler,
  schedulerJobSchema,
} from '../src/scheduler.ts';

/**
 * ADR-0045 slice 7 — the weekly review.
 *
 *   "פעם בשבוע המתזמן של אמריטה יכין חבילת סקירה, לא יבצע שינויים בשקט."
 *
 * The second half of that sentence is the whole test suite: it PROPOSES, it never
 * acts. A scheduler that quietly changes your plan while you sleep is a hazard.
 */

const NOW = new Date('2026-07-14T09:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  const projectId = kernel.ensureProject({ slug: 'f', name: 'Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
  kernel.upsertBrief({
    ...ctx,
    goal: 'Run the Unity Festival',
    finishLine: 'it happens and books at 15K net',
    constraints: [{ kind: 'budget', text: '15K', hard: true }],
  });
  kernel.activateProject({ ...ctx, phases: [{ title: 'Do it' }] });
});
afterEach(() => kernel.close());

describe('the ISO week key — the idempotency anchor', () => {
  it('is stable within a week and changes between weeks', () => {
    expect(isoWeek(new Date('2026-07-14T00:00:00Z'))).toBe(
      isoWeek(new Date('2026-07-16T23:00:00Z')),
    );
    expect(isoWeek(new Date('2026-07-14T00:00:00Z'))).not.toBe(
      isoWeek(new Date('2026-07-22T00:00:00Z')),
    );
  });
});

describe('the packet (pure)', () => {
  const packet = (o: Parameters<typeof buildReviewPacket>[0]) => buildReviewPacket(o);

  it('a clean week is a legitimate answer, and it says so', () => {
    const p = packet({
      projectId: 'p1',
      brief: { finishLine: 'x' } as never,
      tasks: [],
      milestones: [],
      risks: [],
      questions: [],
      now: NOW,
    });
    expect(p.empty).toBe(true);
    expect(renderReviewPacket(p)).toMatch(/nothing is drifting/i);
  });

  it('finds tasks that have stopped moving', () => {
    const p = packet({
      projectId: 'p1',
      brief: { finishLine: 'x' } as never,
      tasks: [
        { id: 't1', title: 'Old task', status: 'now', updatedAt: daysAgo(STALE_DAYS + 3) } as never,
        { id: 't2', title: 'Fresh task', status: 'now', updatedAt: daysAgo(1) } as never,
      ],
      milestones: [],
      risks: [],
      questions: [],
      now: NOW,
    });
    expect(p.stale.map((s) => s.title)).toEqual(['Old task']);
    expect(p.recommendations.join(' ')).toMatch(/Drop them or do them/i);
  });

  it('an unanswered question is a decision being made by default', () => {
    const p = packet({
      projectId: 'p1',
      brief: { finishLine: 'x' } as never,
      tasks: [],
      milestones: [],
      risks: [],
      questions: [
        {
          id: 'q1',
          text: 'who signs the permit?',
          status: 'open',
          createdAt: daysAgo(12),
        } as never,
      ],
      now: NOW,
    });
    expect(p.recommendations.join(' ')).toMatch(/decision being made by default/i);
  });

  it('an overdue milestone says that leaving it is also a decision', () => {
    const p = packet({
      projectId: 'p1',
      brief: { finishLine: 'x' } as never,
      tasks: [],
      milestones: [
        { id: 'm1', title: 'Permits', status: 'active', targetDate: '2026-07-01' } as never,
      ],
      risks: [],
      questions: [],
      now: NOW,
    });
    expect(p.overdue[0]?.daysLate).toBe(13);
    expect(p.recommendations.join(' ')).toMatch(/leaving it is a decision too/i);
  });

  it('the rendered packet ends by saying nothing was changed', () => {
    const p = packet({
      projectId: 'p1',
      brief: null,
      tasks: [
        {
          id: 't',
          title: 'x',
          status: 'now',
          blockedReason: 'Dana',
          updatedAt: daysAgo(1),
        } as never,
      ],
      milestones: [],
      risks: [],
      questions: [],
      now: NOW,
    });
    expect(renderReviewPacket(p)).toMatch(/Nothing here has been changed/i);
  });
});

describe('running the review — it PROPOSES, it never acts (ADR-0045)', () => {
  function drift(): void {
    const { taskId } = kernel.createTask({ ...ctx, title: 'File the permit' });
    kernel.updateTask({ ...ctx, taskId, blockedReason: 'the council has not replied' });
    kernel.openQuestion({ ...ctx, text: 'who signs the permit?' });
    kernel.openRisk({ ...ctx, text: 'rain on the day', severity: 'high' });
  }

  it('raises proposals into the Inbox and one message — and nothing else', () => {
    drift();
    const before = {
      tasks: kernel.listTasks({ projectId: ctx.projectId }).length,
      questions: kernel.listQuestions({ projectId: ctx.projectId }).length,
      risks: kernel.listRisks({ projectId: ctx.projectId }).length,
      decisions: kernel.listDecisions({ projectId: ctx.projectId }).length,
    };

    expect(kernel.runProjectReview(ctx.projectId, NOW)).toBe(true);

    const inbox = kernel.listInbox({ projectId: ctx.projectId, status: 'pending' });
    expect(inbox.length).toBeGreaterThan(0);
    expect(inbox.every((i) => i.origin === 'system')).toBe(true);

    // THE invariant: the plan is untouched.
    expect(kernel.listTasks({ projectId: ctx.projectId })).toHaveLength(before.tasks);
    expect(kernel.listQuestions({ projectId: ctx.projectId })).toHaveLength(before.questions);
    expect(kernel.listRisks({ projectId: ctx.projectId })).toHaveLength(before.risks);
    expect(kernel.listDecisions({ projectId: ctx.projectId })).toHaveLength(before.decisions);
  });

  it('emits ONLY inbox.* and message.system — no domain-mutating event', () => {
    drift();
    const seqBefore = kernel.listEvents(ctx.conversationId, 0).length;
    kernel.runProjectReview(ctx.projectId, NOW);

    const after = kernel.listEvents(ctx.conversationId, 0).slice(seqBefore);
    const types = new Set(after.map((e) => e.type));
    for (const t of types) {
      expect(
        t === 'message.system' || t.startsWith('inbox.'),
        `the review emitted a forbidden event: ${t}`,
      ).toBe(true);
    }
    expect(types.has('message.system')).toBe(true);
  });

  it('is IDEMPOTENT per ISO week — a restart cannot spam a second packet', () => {
    drift();
    expect(kernel.runProjectReview(ctx.projectId, NOW)).toBe(true);
    const first = kernel.listInbox({ projectId: ctx.projectId }).length;

    // same week, run again (this is exactly what a daemon restart used to cause)
    expect(kernel.runProjectReview(ctx.projectId, NOW)).toBe(false);
    expect(kernel.runProjectReview(ctx.projectId, new Date('2026-07-16T09:00:00Z'))).toBe(false);
    expect(kernel.listInbox({ projectId: ctx.projectId })).toHaveLength(first);

    // …but next week it speaks again
    expect(kernel.runProjectReview(ctx.projectId, new Date('2026-07-22T09:00:00Z'))).toBe(true);
    expect(kernel.listInbox({ projectId: ctx.projectId }).length).toBeGreaterThan(first);
  });

  it('says nothing about a project that never started', () => {
    const p2 = kernel.ensureProject({ slug: 'x', name: 'X' }).id;
    expect(kernel.runProjectReview(p2, NOW)).toBe(false);
  });

  it('says nothing when nothing is drifting', () => {
    expect(kernel.runProjectReview(ctx.projectId, NOW)).toBe(false);
    expect(kernel.listInbox({ projectId: ctx.projectId })).toHaveLength(0);
  });
});

describe('the scheduler can finally express "weekly" (ADR-0045)', () => {
  it('accepts a 7-day interval — the old ceiling was 24h, which made weekly IMPOSSIBLE', () => {
    expect(schedulerJobSchema.safeParse(DEFAULT_REVIEW_JOB).success).toBe(true);
    expect(DEFAULT_REVIEW_JOB.intervalMinutes).toBe(7 * 24 * 60);
  });

  it('rejects anything longer than a week', () => {
    expect(
      schedulerJobSchema.safeParse({ ...DEFAULT_REVIEW_JOB, intervalMinutes: 8 * 24 * 60 }).success,
    ).toBe(false);
  });

  it('remembers when it last ran ACROSS A RESTART — the in-memory Map re-fired everything', async () => {
    const kernel2 = AmritaKernel.open({ dbPath: ':memory:' });
    const pid = kernel2.ensureProject({ slug: 'r', name: 'R' }).id;
    const cid = kernel2.createConversation({ projectId: pid }).id;
    kernel2.upsertBrief({
      projectId: pid,
      conversationId: cid,
      goal: 'g',
      finishLine: 'f',
      constraints: [{ kind: 'budget', text: 'b', hard: true }],
    });
    kernel2.activateProject({ projectId: pid, conversationId: cid, phases: [{ title: 'p' }] });
    const { taskId } = kernel2.createTask({ projectId: pid, conversationId: cid, title: 't' });
    kernel2.updateTask({ projectId: pid, conversationId: cid, taskId, blockedReason: 'stuck' });

    kernel2.updateSetting({
      projectId: pid,
      conversationId: cid,
      key: SCHEDULER_JOBS_SETTING,
      value: [DEFAULT_REVIEW_JOB],
    });

    const s1 = new Scheduler(kernel2, { now: () => NOW });
    await s1.tick();
    const afterFirst = kernel2.listInbox({ projectId: pid }).length;
    expect(afterFirst).toBeGreaterThan(0);

    // A brand-new Scheduler = a restarted daemon. Its in-memory map is empty, so
    // the ONLY thing stopping a duplicate packet is the persisted run-state.
    const s2 = new Scheduler(kernel2, { now: () => new Date(NOW.getTime() + 60_000) });
    await s2.tick();
    expect(kernel2.listInbox({ projectId: pid })).toHaveLength(afterFirst);
    expect(s2.status().jobs[0]?.lastRunAt).toBeTruthy(); // it remembered

    kernel2.close();
  });
});
