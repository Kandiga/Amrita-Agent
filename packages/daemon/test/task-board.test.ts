import { newId } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/**
 * ADR-0044 slice 4: `tasks.update` reaches the wire.
 *
 * `store.updateTask` was written, tested and REACHABLE BY NOBODY since ADR-0018 —
 * no kernel method, no RPC, no client. A board drag was therefore not expressible
 * at any layer. These tests pin the whole path: RPC → kernel → store → event →
 * projection → read.
 */

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  const projectId = kernel.ensureProject({ slug: 'festival', name: 'Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
});
afterEach(() => kernel.close());

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result;
}

async function expectRpcError(method: string, params: unknown): Promise<string> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (!isErrorResponse(r)) throw new Error(`${method} unexpectedly succeeded`);
  return r.error.code;
}

describe('tasks.update over the wire (ADR-0044)', () => {
  it('drags a card: status + order key, in one typed event', async () => {
    const { taskId } = (await rpc('tasks.create', {
      ...ctx,
      title: 'File the permit',
      status: 'later',
    })) as { taskId: string };

    await rpc('tasks.update', { ...ctx, taskId, status: 'now', orderKey: 'a5' });

    const tasks = kernel.listTasks({ projectId: ctx.projectId });
    expect(tasks[0]).toMatchObject({ status: 'now', orderKey: 'a5' });

    const events = kernel.listEvents(ctx.conversationId, 0).map((e) => e.type);
    expect(events.filter((t) => t === 'task.updated')).toHaveLength(1);
  });

  it('assigns an owner, a due date and a priority', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'x' })) as { taskId: string };
    await rpc('tasks.update', {
      ...ctx,
      taskId,
      owner: 'Dana',
      dueDate: '2026-09-01',
      priority: 'high',
    });
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]).toMatchObject({
      owner: 'Dana',
      dueDate: '2026-09-01',
      priority: 'high',
    });
  });

  it('null CLEARS a field over the wire (un-assign, unblock)', async () => {
    const { taskId } = (await rpc('tasks.create', {
      ...ctx,
      title: 'x',
      owner: 'Dana',
      blockedReason: 'waiting on the council',
    })) as { taskId: string };

    await rpc('tasks.update', { ...ctx, taskId, owner: null, blockedReason: null });

    expect(kernel.listTasks({ projectId: ctx.projectId })[0]).toMatchObject({
      owner: null,
      blockedReason: null,
    });
  });

  it('rejects a malformed date and an unknown priority as invalid_params', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'x' })) as { taskId: string };
    expect(await expectRpcError('tasks.update', { ...ctx, taskId, dueDate: '3rd March' })).toBe(
      'invalid_params',
    );
    expect(await expectRpcError('tasks.update', { ...ctx, taskId, priority: 'urgent' })).toBe(
      'invalid_params',
    );
  });

  it('carries the laneId the wire used to drop (it must be a real ULID)', async () => {
    const laneId = newId();
    const { taskId } = (await rpc('tasks.create', {
      ...ctx,
      title: 'delegated work',
      laneId,
    })) as { taskId: string };
    const t = kernel.listTasks({ projectId: ctx.projectId }).find((x) => x.id === taskId);
    expect(t?.laneId).toBe(laneId);

    // and the protocol still refuses a made-up id — the link is typed, not a string
    expect(await expectRpcError('tasks.create', { ...ctx, title: 'z', laneId: 'lane-123' })).toBe(
      'invalid_params',
    );
  });

  it('re-links and unlinks a milestone', async () => {
    const { milestoneId } = kernel.createMilestone({ ...ctx, title: 'Permits' });
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'x' })) as { taskId: string };

    await rpc('tasks.update', { ...ctx, taskId, milestoneId });
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.milestoneId).toBe(milestoneId);

    await rpc('tasks.update', { ...ctx, taskId, milestoneId: null });
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.milestoneId).toBeNull();
  });

  it('the board change is visible to the agent on the very next turn', async () => {
    const { taskId } = (await rpc('tasks.create', { ...ctx, title: 'File the permit' })) as {
      taskId: string;
    };
    await rpc('tasks.update', { ...ctx, taskId, status: 'later', owner: 'Dana' });

    // The context pack is rebuilt from the store every turn (ADR-0044 slice 1) —
    // so a drag needs no second chat message and no cache invalidation.
    const pack = await kernel.buildContextPack(ctx.projectId);
    expect(pack).toContain('[later] File the permit');
  });
});
