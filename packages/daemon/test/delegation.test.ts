import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaneMandate, MergeReport } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTE_LABEL, routeFor } from '../src/execution-route.ts';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/**
 * ADR-0045 slice 6 — execution routes, delegation, and the lane's results.
 *
 *   "לכל משימה באמריטה יהיה מסלול ברור… אם חסר חיבור היא לא מתחזה, היא אומרת
 *    בדיוק איזה חיבור חסר, למה הוא דרוש ומה הסיכון באישורו."
 *
 *   "היא לא אומרת 'סיימתי' בלי הוכחה."
 */

const task = (o: Partial<Parameters<typeof routeFor>[0]['task']> = {}) =>
  ({
    title: 'x',
    body: null,
    status: 'now',
    blockedReason: null,
    laneId: null,
    ...o,
  }) as Parameters<typeof routeFor>[0]['task'];

const route = (t: Partial<Parameters<typeof routeFor>[0]['task']>, over = {}) =>
  routeFor({
    task: task(t),
    hasRoot: true,
    runtimeReady: true,
    realExecution: true,
    ...over,
  });

describe('execution routes — derived, never stored (ADR-0045)', () => {
  it('ordinary work is just do-now', () => {
    expect(route({ title: 'Hang the bunting' }).route).toBe('do-now');
  });

  it('codeable work Amrita can actually run → delegate', () => {
    const v = route({ title: 'Fix the failing test in the checkout flow' });
    expect(v.route).toBe('delegate');
    expect(v.detail).toMatch(/budget and a receipt/i);
  });

  it('a task needing EMAIL says exactly what is missing, why, and what approving it costs', () => {
    const v = route({ title: 'Send an email to the vendors' });
    expect(v.route).toBe('needs-connector');
    expect(v.missing?.what).toMatch(/email connector/i);
    expect(v.missing?.why).toBeTruthy();
    // "ומה הסיכון באישורו" — the risk of approving it
    expect(v.missing?.risk).toMatch(/read and send mail/i);
    expect(v.missing?.fix).toMatch(/built yet/i);
  });

  it('never pretends: a calendar task is honest about having no calendar', () => {
    expect(route({ title: 'Schedule a meeting with the council' }).route).toBe('needs-connector');
  });

  it('work a machine must not quietly do on your behalf is HUMAN ONLY', () => {
    expect(route({ title: 'Call the caterer' }).route).toBe('human-only');
    expect(route({ title: 'Sign the venue contract' }).route).toBe('human-only');
    expect(route({ title: 'Negotiate the vendor rate' }).route).toBe('human-only');
  });

  it('codeable work with NO project folder cannot be delegated yet', () => {
    const v = route({ title: 'Refactor the API' }, { hasRoot: false });
    expect(v.route).toBe('needs-approval');
    expect(v.detail).toMatch(/no working folder/i);
  });

  it('codeable work with NO runtime says which runtime is missing', () => {
    const v = route({ title: 'Refactor the API' }, { runtimeReady: false });
    expect(v.route).toBe('needs-connector');
    expect(v.missing?.what).toMatch(/coding runtime/i);
  });

  it('a dry-run-only daemon needs approval before it can really execute', () => {
    expect(route({ title: 'Fix the bug' }, { realExecution: false }).route).toBe('needs-approval');
  });

  it('an already-delegated task reads as delegated', () => {
    expect(route({ title: 'Fix the bug', laneId: '01KXH15R9K1W1MM86W52WVWABH' }).route).toBe(
      'delegate',
    );
  });

  it('a blocked task is human-only until it is unblocked', () => {
    expect(route({ title: 'Hang the bunting', blockedReason: 'no bunting' }).route).toBe(
      'human-only',
    );
  });

  it('every route has a human label', () => {
    expect(Object.keys(ROUTE_LABEL)).toHaveLength(5);
  });
});

// ── delegation + merge-back, against a real kernel ───────────────────────────

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };
let dir: string;

/** A fake lane that reports typed results — the thing that used to be thrown away. */
const fakeRunner = {
  kind: 'claude-code',
  async run(mandate: LaneMandate): Promise<MergeReport> {
    return {
      laneId: mandate.laneId,
      summary: 'refactored the checkout flow',
      artifacts: [],
      decisions: ['switched to the new payment SDK'],
      tasks: ['add a regression test for the discount path'],
      followUps: ['the legacy adapter can be deleted next sprint'],
      usage: { inputTokens: 1, outputTokens: 1 },
      exit: 'done' as const,
    };
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-delegate-'));
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    laneRunner: fakeRunner,
    allowRealLaneExecution: true,
    laneAllowedRoots: [dir],
    codingRuntimeProber: async () => ({ kind: 'ok', stdout: '1.0.0', stderr: '' }),
  });
  const projectId = kernel.ensureProject({ slug: 'p', name: 'P' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
});
afterEach(() => {
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
});

async function rpcErr(method: string, params: unknown): Promise<{ code: string; message: string }> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (!isErrorResponse(r)) throw new Error(`${method} unexpectedly succeeded`);
  return r.error;
}

describe('binding a project root (ADR-0045)', () => {
  it('the root was WRITE-ONCE and therefore unreachable — now it can be bound', () => {
    expect(kernel.getProject({ id: ctx.projectId })?.root).toBeNull();
    kernel.setProjectRoot({ ...ctx, root: dir });
    expect(kernel.getProject({ id: ctx.projectId })?.root).toBe(dir);
  });

  it('REFUSES a path outside every allowed root — the browser never picks a path', async () => {
    const err = await rpcErr('projects.setRoot', { ...ctx, root: '/etc' });
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/outside every allowed root/i);
    expect(kernel.getProject({ id: ctx.projectId })?.root).toBeNull();
  });

  it('refuses a folder that does not exist rather than inventing a tree', async () => {
    const err = await rpcErr('projects.setRoot', { ...ctx, root: join(dir, 'nope') });
    expect(err.code).toBe('not_found');
  });

  it('binding the root is audited', () => {
    kernel.setProjectRoot({ ...ctx, root: dir, origin: 'user' });
    const ev = kernel.listEvents(ctx.conversationId, 0).find((e) => e.type === 'project.updated');
    expect(ev?.payload).toMatchObject({ fields: ['root'] });
  });
});

describe("task → lane, and the lane's results (ADR-0045)", () => {
  it('refuses to delegate something Amrita cannot actually do', async () => {
    kernel.setProjectRoot({ ...ctx, root: dir });
    const { taskId } = kernel.createTask({ ...ctx, title: 'Call the caterer' });
    const err = await rpcErr('tasks.delegate', { ...ctx, taskId });
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/human-only/i);
  });

  it('delegates a codeable task, links the lane to the card, and captures the RESULTS', async () => {
    kernel.setProjectRoot({ ...ctx, root: dir });
    const { taskId } = kernel.createTask({ ...ctx, title: 'Refactor the checkout flow' });

    const out = await kernel.delegateTask({ ...ctx, taskId });
    expect(out.laneId).toBeTruthy();

    // the card and the lane can never drift apart
    expect(kernel.listTasks({ projectId: ctx.projectId })[0]?.laneId).toBe(out.laneId);

    // A REAL lane run pauses for approval (ADR-0021) — delegation does not bypass
    // the gate, it goes through it. Nothing runs until a human says yes.
    await new Promise((r) => setTimeout(r, 50));
    const pending = kernel.listPendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.action).toBe('lane.run-real');
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'allow');

    // now it can finish
    await new Promise((r) => setTimeout(r, 200));

    // ADR-0045: the lane's TYPED outputs used to be discarded entirely. Now they
    // are proposals in the same Inbox as everything else an agent produces.
    const inbox = kernel.listInbox({ projectId: ctx.projectId, status: 'pending' });
    const texts = inbox.map((i) => i.text);
    expect(texts).toContain('add a regression test for the discount path');
    expect(texts).toContain('switched to the new payment SDK');
    expect(texts).toContain('the legacy adapter can be deleted next sprint');
    expect(inbox.every((i) => i.origin === 'lane')).toBe(true);

    // …and NOT project truth. A lane proposes; a human disposes.
    expect(kernel.listTasks({ projectId: ctx.projectId })).toHaveLength(1); // just the original
    expect(kernel.listDecisions({ projectId: ctx.projectId })).toHaveLength(0);
  });

  it('refuses to delegate the same task twice', async () => {
    kernel.setProjectRoot({ ...ctx, root: dir });
    const { taskId } = kernel.createTask({ ...ctx, title: 'Fix the failing test' });
    await kernel.delegateTask({ ...ctx, taskId });
    const err = await rpcErr('tasks.delegate', { ...ctx, taskId });
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/already delegated/i);
  });
});
