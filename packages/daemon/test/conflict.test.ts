import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/**
 * ADR-0045 — the system must NOT silently overwrite.
 *
 * From the product brief (voice, file 03):
 *   "במקרה של שני שינויים מתנגשים, המערכת לא דורסת בשקט.
 *    היא מזהה גרסה ישנה, מציגה קונפליקט ומבקשת הכרעה."
 *
 * Before this, `tasks.update` just wrote. Two tabs dragging the same card, or the
 * Scribe racing a human edit, ended with the last writer winning in silence. The
 * brief was worse: it is a FULL-document upsert, so a stale save did not lose one
 * field — it wiped the whole charter someone else had just written.
 */

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  const projectId = kernel.ensureProject({ slug: 'p', name: 'P' }).id;
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

describe('tasks: a stale write is refused, not applied (ADR-0045)', () => {
  it('REFUSES a second writer who saw an older version', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'File the permit' })) as {
      taskId: string;
    };
    // Both tabs load the card and see the same version.
    const seen = kernel.listTasks({ projectId: ctx.projectId })[0]?.version;
    expect(seen).toBe(0);

    // Tab A drags it to Later. Succeeds.
    await rpc('tasks.update', {
      ...ctx,
      taskId,
      status: 'later',
      expectedVersion: seen,
    });

    // Tab B, still holding the OLD version, drags it to Done.
    const err = await rpcErr('tasks.update', {
      ...ctx,
      taskId,
      status: 'done',
      expectedVersion: seen,
    });

    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/changed by someone else/i);

    // Tab A's work survived. Tab B did NOT quietly win.
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.status).toBe('later');
  });

  it('lets the second writer through once they reload (the resolution path)', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'x' })) as { taskId: string };
    const first = kernel.listTasks({ projectId: ctx.projectId })[0]?.version;
    await rpc('tasks.update', { ...ctx, taskId, status: 'later', expectedVersion: first });

    // Reload → see the new version → reapply. (A TIMESTAMP token would fail here:
    // both writes can land in the same millisecond. A counter cannot collide.)
    const fresh = kernel.listTasks({ projectId: ctx.projectId })[0]?.version;
    expect(fresh).toBe(1);
    expect(fresh).not.toBe(first);
    await rpc('tasks.update', { ...ctx, taskId, status: 'done', expectedVersion: fresh });
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.status).toBe('done');
  });

  it('opting out (no expectedVersion) still works — the CLI and the agent do not lock', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'x' })) as { taskId: string };
    await rpc('tasks.update', { ...ctx, taskId, status: 'later' });
    await rpc('tasks.update', { ...ctx, taskId, status: 'done' });
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.status).toBe('done');
  });

  it('a refused write emits NO event — the log stays clean', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'x' })) as { taskId: string };
    const seen = kernel.listTasks({ projectId: ctx.projectId })[0]?.version;
    await rpc('tasks.update', { ...ctx, taskId, status: 'later', expectedVersion: seen });

    const before = kernel.listEvents(ctx.conversationId, 0).length;
    await rpcErr('tasks.update', { ...ctx, taskId, status: 'done', expectedVersion: seen });
    expect(kernel.listEvents(ctx.conversationId, 0).length).toBe(before);
  });
});

describe('brief: a stale write would WIPE the charter — refused (ADR-0045)', () => {
  it('refuses a stale full-document save instead of erasing the other charter', async () => {
    await rpc('projects.brief.update', { ...ctx, goal: 'Run the Unity Festival' });
    const seen = kernel.getCompanion(ctx.projectId).brief?.version;

    // Operator A adds the whole charter.
    await rpc('projects.brief.update', {
      ...ctx,
      goal: 'Run the Unity Festival',
      finishLine: 'the festival happens and books at 15K net',
      constraints: [{ kind: 'budget', text: '15K net', hard: true }],
      decisionRights: [{ area: 'vendors', approver: 'the arts council' }],
      expectedVersion: seen,
    });

    // Operator B, holding the OLD version, saves a goal-only edit. Without the
    // guard this would blow away the finish line, the constraints AND the rights.
    const err = await rpcErr('projects.brief.update', {
      ...ctx,
      goal: 'Run the Unity Festival (renamed)',
      expectedVersion: seen,
    });
    expect(err.code).toBe('conflict');

    const brief = kernel.getCompanion(ctx.projectId).brief;
    expect(brief?.finishLine).toBe('the festival happens and books at 15K net');
    expect(brief?.constraints).toHaveLength(1);
    expect(brief?.decisionRights).toHaveLength(1);
  });

  it('creating the FIRST brief needs no expected version', async () => {
    await rpc('projects.brief.update', { ...ctx, goal: 'fresh start' });
    expect(kernel.getCompanion(ctx.projectId).brief?.goal).toBe('fresh start');
  });
});
