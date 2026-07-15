import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/**
 * ADR-0045 — a board is never conjured out of nothing.
 *
 * "היום רוב מערכות הניהול מבקשות ממך לפתוח פרויקט, לתת שם ואז זורקות אותך לתוך
 *  לוח ריק. אנחנו רוצים בדיוק ההפך… כאשר יש מספיק בסיס, אמריטה מציעה להפעיל את
 *  הפרויקט. רק אחרי אישור שלך היא יוצרת אבני דרך, שלבים ומשימות ראשונות."
 */

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  const projectId = kernel.ensureProject({ slug: 'f', name: 'Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
});
afterEach(() => kernel.close());

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}|${r.error.message}`);
  return r.result;
}
async function rpcErr(method: string, params: unknown): Promise<{ code: string; message: string }> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (!isErrorResponse(r)) throw new Error(`${method} unexpectedly succeeded`);
  return r.error;
}

function writeCharter(): void {
  kernel.upsertBrief({
    ...ctx,
    goal: 'Run the Unity Festival',
    finishLine: 'the festival happens and books at 15K net',
    constraints: [{ kind: 'budget', text: '15K net', hard: true }],
    decisionRights: [{ area: 'spend', approver: 'Casey' }],
    successCriteria: ['500 attendees'],
  });
}

describe('project activation (ADR-0045)', () => {
  it('a new project is NOT activated — it is a conversation, not an empty board', () => {
    const p = kernel.getProject({ id: ctx.projectId });
    expect(p?.activatedAt).toBeNull();
    expect(kernel.getCharterStatus(ctx.projectId).readyToActivate).toBe(false);
  });

  it('REFUSES to activate a project whose charter has no basis', async () => {
    const err = await rpcErr('projects.activate', {
      ...ctx,
      phases: [{ title: 'Do the work' }],
    });
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/no basis yet/i);
    expect(kernel.listPhases(ctx.projectId)).toHaveLength(0);
    expect(kernel.listTasks({ projectId: ctx.projectId })).toHaveLength(0);
  });

  it('proposes activation only once the charter has a goal, a finish line and a constraint', () => {
    expect(kernel.getCharterStatus(ctx.projectId).readyToActivate).toBe(false);
    writeCharter();
    expect(kernel.getCharterStatus(ctx.projectId).readyToActivate).toBe(true);
  });

  it('on approval, creates the phases, milestones and first tasks — and nothing before', async () => {
    writeCharter();
    expect(kernel.listPhases(ctx.projectId)).toHaveLength(0); // still nothing

    const out = (await rpc('projects.activate', {
      ...ctx,
      phases: [{ title: 'Permits' }, { title: 'Vendors' }, { title: 'The day itself' }],
      milestones: [{ title: 'Permits secured', targetDate: '2026-09-01' }],
      tasks: [
        { title: 'File the park permit', phaseIndex: 0 },
        { title: 'Call the caterer', phaseIndex: 1 },
      ],
    })) as { phaseIds: string[]; milestoneIds: string[]; taskIds: string[] };

    expect(out.phaseIds).toHaveLength(3);
    expect(out.milestoneIds).toHaveLength(1);
    expect(out.taskIds).toHaveLength(2);

    const phases = kernel.listPhases(ctx.projectId);
    expect(phases.map((p) => p.title)).toEqual(['Permits', 'Vendors', 'The day itself']);

    const tasks = kernel.listTasks({ projectId: ctx.projectId });
    expect(tasks.find((t) => t.title === 'File the park permit')?.phaseId).toBe(out.phaseIds[0]);
    expect(tasks.find((t) => t.title === 'Call the caterer')?.phaseId).toBe(out.phaseIds[1]);

    // The project is now a plan.
    expect(kernel.getProject({ id: ctx.projectId })?.activatedAt).toBeTruthy();
  });

  it('marks the tasks it proposed as INFERRED — you approved them, you did not say them', async () => {
    writeCharter();
    await rpc('projects.activate', {
      ...ctx,
      phases: [{ title: 'Permits' }],
      tasks: [{ title: 'File the park permit', phaseIndex: 0 }],
    });
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.certainty).toBe('inferred');
  });

  it('refuses to activate twice', async () => {
    writeCharter();
    await rpc('projects.activate', { ...ctx, phases: [{ title: 'Permits' }] });
    const err = await rpcErr('projects.activate', { ...ctx, phases: [{ title: 'Again' }] });
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/already activated/i);
    expect(kernel.listPhases(ctx.projectId)).toHaveLength(1); // not duplicated
  });

  it('emits project.activated with a truthful count', async () => {
    writeCharter();
    await rpc('projects.activate', {
      ...ctx,
      phases: [{ title: 'A' }, { title: 'B' }],
      tasks: [{ title: 't1' }],
    });
    const ev = kernel.listEvents(ctx.conversationId, 0).find((e) => e.type === 'project.activated');
    expect(ev?.payload).toMatchObject({ phaseCount: 2, milestoneCount: 0, taskCount: 1 });
  });

  it('a phase reference that does not exist is refused at the SQL layer', () => {
    expect(() =>
      kernel.createTask({ ...ctx, title: 'x', phaseId: '01KXGVX7HN1BWP3QGFF1BMBXRX' }),
    ).toThrow();
  });

  it('the activated project reaches the agent context as phases', async () => {
    writeCharter();
    await rpc('projects.activate', {
      ...ctx,
      phases: [{ title: 'Permits' }],
      tasks: [{ title: 'File the park permit', phaseIndex: 0 }],
    });
    const pack = await kernel.buildContextPack(ctx.projectId);
    expect(pack).toContain('File the park permit');
  });
});
