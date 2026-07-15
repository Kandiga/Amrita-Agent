import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { ORG_MEMORY_SOURCE_PREFIX, buildRetroPacket, renderRetroPacket } from '../src/retro.ts';
import { METHODS } from '../src/rpc.ts';

/**
 * ADR-0045 slice 9 — the retrospective, and what crosses out of a project.
 *
 *   "הלקחים לא יזלגו אוטומטית לכל הפרויקטים. אתה תאשר מה הופך לידע ארגוני, והוא
 *    יישמר עם המקור וההקשר."
 *
 * Cross-project learning is the most dangerous feature in a system like this: one
 * project's hard-won lesson is another project's confidently-wrong assumption. The
 * tests below exist to make sure the door only opens by hand.
 */

const NOW = new Date('2026-07-14T09:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  const projectId = kernel.ensureProject({ slug: 'f', name: 'Unity Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
  kernel.upsertBrief({
    ...ctx,
    goal: 'Run the Unity Festival',
    finishLine: 'the festival happens and books at 15K net',
    successCriteria: ['500 attendees'],
    constraints: [{ kind: 'budget', text: '15K', hard: true }],
  });
});
afterEach(() => kernel.close());

describe('the retro packet is COMPUTED from what happened (ADR-0045)', () => {
  const packet = (o: Partial<Parameters<typeof buildRetroPacket>[0]>) =>
    buildRetroPacket({
      projectId: 'p1',
      brief: null,
      tasks: [],
      milestones: [],
      risks: [],
      questions: [],
      decisions: [],
      now: NOW,
      ...o,
    });

  it('a project where nothing slipped says so — and admits that is rare', () => {
    const p = packet({});
    expect(p.empty).toBe(true);
    expect(renderRetroPacket(p)).toMatch(/That is rare/i);
  });

  it('"מה אבד" — a milestone that passed its date without being finished', () => {
    const p = packet({
      milestones: [
        { id: 'm1', title: 'Permits secured', status: 'active', targetDate: '2026-06-01' } as never,
      ],
    });
    expect(p.findings[0]?.kind).toBe('slipped');
    expect(p.outcome.milestonesMissed).toBe(1);
    expect(p.lessons.join(' ')).toMatch(/Start it earlier/i);
  });

  it('"אילו הנחות היו שגויות" — a question nobody ever answered', () => {
    const p = packet({
      questions: [
        { id: 'q', text: 'who signs the permit?', status: 'open', createdAt: daysAgo(40) } as never,
      ],
    });
    expect(p.findings[0]?.kind).toBe('unanswered');
    expect(p.findings[0]?.detail).toMatch(/proceeded on an assumption/i);
  });

  it('a task that finished the project still blocked names what blocked it', () => {
    const p = packet({
      tasks: [
        {
          id: 't',
          title: 'Book the venue',
          status: 'now',
          blockedReason: 'vendor approvals',
        } as never,
      ],
    });
    expect(p.findings[0]?.kind).toBe('never-moved');
    // exactly the example from the brief: "התאריך נשבר בגלל אישור ספקים"
    expect(p.lessons.join(' ')).toMatch(/vendor approvals/i);
    expect(p.lessons.join(' ')).toMatch(/Open that track early/i);
  });

  it('counts the outcome honestly, not flatteringly', () => {
    const p = packet({
      brief: { finishLine: 'it ships', successCriteria: ['x'] } as never,
      tasks: [
        { id: 'a', status: 'done', title: 'a' } as never,
        { id: 'b', status: 'now', title: 'b' } as never,
        { id: 'c', status: 'dropped', title: 'c' } as never,
      ],
    });
    expect(p.outcome.tasksDone).toBe(1);
    expect(p.outcome.tasksTotal).toBe(2); // dropped tasks are not "total"
    expect(p.findings.some((f) => f.kind === 'dropped')).toBe(true);
  });

  it('the rendered packet says lessons do not cross by themselves', () => {
    const p = packet({
      risks: [{ id: 'r', text: 'rain', status: 'open', severity: 'high' } as never],
    });
    expect(renderRetroPacket(p)).toMatch(/does not cross|crosses into another project by itself/i);
  });
});

describe('nothing crosses out of a project by itself (ADR-0045)', () => {
  function endBadly(): void {
    const { taskId } = kernel.createTask({ ...ctx, title: 'Book the venue' });
    kernel.updateTask({ ...ctx, taskId, blockedReason: 'vendor approvals' });
    kernel.openQuestion({ ...ctx, text: 'who signs the permit?' });
  }

  it('running the retro keeps everything INSIDE the project', () => {
    endBadly();
    const { lessons } = kernel.runRetro({ ...ctx }, NOW);
    expect(lessons.length).toBeGreaterThan(0);

    // project-scoped memory: yes.
    const projectMemory = kernel.store.listMemoryEntries(ctx.projectId);
    expect(projectMemory.some((m) => m.source === 'retro')).toBe(true);

    // organizational memory: NOT YET. Nothing has been promoted.
    expect(kernel.searchMemory('vendor', { scope: 'user' })).toHaveLength(0);
  });

  it('promotion is ONE lesson, by hand, and it carries its origin', () => {
    endBadly();
    const { lessons } = kernel.runRetro({ ...ctx }, NOW);
    const lesson = lessons.find((l) => /vendor approvals/i.test(l));
    expect(lesson).toBeTruthy();

    kernel.promoteLesson({ ...ctx, lesson: lesson as string, origin: 'user' });

    const org = kernel.searchMemory('vendor', { scope: 'user' });
    expect(org).toHaveLength(1);
    // "יישמר עם המקור וההקשר" — the next project is told WHOSE experience this is.
    expect(org[0]?.content).toMatch(/learned on: Unity Festival/i);
    expect(org[0]?.source).toBe(`${ORG_MEMORY_SOURCE_PREFIX}${ctx.projectId}`);
  });

  it('a promoted lesson reaches the NEXT project — with attribution', () => {
    endBadly();
    const { lessons } = kernel.runRetro({ ...ctx }, NOW);
    const lesson = lessons.find((l) => /vendor approvals/i.test(l)) as string;
    kernel.promoteLesson({ ...ctx, lesson });

    // A brand-new project. It can see organizational memory…
    const p2 = kernel.ensureProject({ slug: 'next', name: 'Next Festival' }).id;
    const org = kernel.searchMemory('vendor', { scope: 'user' });
    expect(org[0]?.content).toContain('Unity Festival');

    // …but the new project's OWN memory is untouched. No silent contamination.
    expect(kernel.store.listMemoryEntries(p2)).toHaveLength(0);
  });

  it('there is no "promote all" — only one lesson at a time', () => {
    // The ABSENCE of a bulk verb is the feature. If someone ever adds one, this fails
    // loudly, and they have to come and argue with this comment first.
    const methods = Object.keys(METHODS);
    expect(methods.filter((m) => /retro.*promote/i.test(m))).toEqual(['projects.retro.promote']);
    expect(methods.some((m) => /promoteall|promote\.all|promote_all/i.test(m))).toBe(false);
  });
});
