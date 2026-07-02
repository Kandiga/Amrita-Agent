import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel, dispatch, isErrorResponse } from '../src/index.ts';

let kernel: AmritaKernel;
beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => kernel.close());

async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

function ctx(): { projectId: string; conversationId: string } {
  const projectId = kernel.ensureProject({ slug: 'cine', name: 'Cine' }).id;
  const conversationId = kernel.createConversation({ projectId, title: 'Cinema sync' }).id;
  return { projectId, conversationId };
}

describe('cinema mandates (ADR-0029)', () => {
  it('issue → list(open) → complete → list(resolved), all via RPC', async () => {
    const { projectId, conversationId } = ctx();
    const { mandateId } = await call<{ mandateId: string }>('cinema.mandate.issue', {
      projectId,
      conversationId,
      goal: 'הוסף שוט פתיחה של זריחה ותכין קיפריים',
      maxRisk: 'credit',
      note: 'teaser for the launch',
    });
    expect(mandateId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const open = await call<{ mandate: { mandateId: string; goal: string }; status: string }[]>(
      'cinema.mandate.list',
      { conversationId, openOnly: true },
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.mandate.goal).toContain('שוט פתיחה');

    const done = await call<{ ok: boolean }>('cinema.mandate.complete', {
      projectId,
      conversationId,
      report: {
        mandateId,
        exit: 'done',
        summary: 'Added the shot and generated the keyframe (user applied the plan).',
        opsApplied: ['addShot: זריחה'],
        plansApplied: ['Generate keyframes for 1 shot'],
      },
    });
    expect(done.ok).toBe(true);

    const all = await call<{ status: string; report?: { exit: string } }[]>('cinema.mandate.list', {
      conversationId,
    });
    expect(all[0]?.status).toBe('resolved');
    expect(all[0]?.report?.exit).toBe('done');
    expect(await call('cinema.mandate.list', { conversationId, openOnly: true })).toHaveLength(0);
  });

  it('completing twice or completing an unknown mandate is a safe no-op result', async () => {
    const { projectId, conversationId } = ctx();
    const { mandateId } = await call<{ mandateId: string }>('cinema.mandate.issue', {
      projectId,
      conversationId,
      goal: 'goal',
    });
    const report = { mandateId, exit: 'refused', summary: 'operator discarded the plan' };
    expect(
      (
        await call<{ ok: boolean }>('cinema.mandate.complete', {
          projectId,
          conversationId,
          report,
        })
      ).ok,
    ).toBe(true);
    const again = await call<{ ok: boolean; reason?: string }>('cinema.mandate.complete', {
      projectId,
      conversationId,
      report,
    });
    expect(again).toEqual({ ok: false, reason: 'already-resolved' });
    const ghost = await call<{ ok: boolean; reason?: string }>('cinema.mandate.complete', {
      projectId,
      conversationId,
      report: { ...report, mandateId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    });
    expect(ghost).toEqual({ ok: false, reason: 'not-found' });
  });

  it('mandate confinement fields validate: bad verb and oversize goal rejected', async () => {
    const { projectId, conversationId } = ctx();
    await expect(
      call('cinema.mandate.issue', {
        projectId,
        conversationId,
        goal: 'g',
        allowedVerbs: ['rm -rf'], // not in the module vocabulary → protocol parse fails
      }),
    ).rejects.toThrow();
    await expect(
      call('cinema.mandate.issue', { projectId, conversationId, goal: 'x'.repeat(2001) }),
    ).rejects.toThrow();
  });
});
