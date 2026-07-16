import { describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';
import { machineCriteria, resolveWithinRoot, runAcceptance } from '../src/task-verify.ts';

/** ADR-0055 — evidence-based done: pure verification core + gated kernel run. */

const IO = (over: Partial<Parameters<typeof runAcceptance>[1]> = {}) => ({
  root: '/proj',
  fileExists: () => true,
  exec: async () => ({ code: 0 }),
  now: () => '2026-07-16T00:00:00.000Z',
  ...over,
});

describe('runAcceptance (pure, injected IO)', () => {
  it('file criteria pass/fail on existence, jailed to the project folder', async () => {
    const v = await runAcceptance(
      [
        { kind: 'file', path: 'dist/index.html' },
        { kind: 'file', path: 'missing.txt' },
        { kind: 'file', path: '../../etc/passwd' }, // escape → honest failure
      ],
      IO({ fileExists: (p) => p === '/proj/dist/index.html' }),
    );
    expect(v.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(v.results[2]?.detail).toMatch(/escapes/);
    expect(v.passed).toBe(false);
  });

  it('command criteria pass on exit 0 and record only the exit code', async () => {
    const seen: string[] = [];
    const v = await runAcceptance(
      [
        { kind: 'command', run: 'pnpm test' },
        { kind: 'command', run: 'pnpm lint' },
      ],
      IO({
        exec: async (run) => {
          seen.push(run);
          return { code: run === 'pnpm lint' ? 1 : 0 };
        },
      }),
    );
    expect(seen).toEqual(['pnpm test', 'pnpm lint']);
    expect(v.results.map((r) => [r.ok, r.detail])).toEqual([
      [true, 'exit 0'],
      [false, 'exit 1'],
    ]);
    expect(v.passed).toBe(false);
  });

  it('manual criteria are human judgement — excluded from machine runs', async () => {
    expect(machineCriteria([{ kind: 'manual', text: 'looks right' }])).toEqual([]);
    const v = await runAcceptance(
      [
        { kind: 'manual', text: 'looks right' },
        { kind: 'file', path: 'a' },
      ],
      IO(),
    );
    expect(v.results).toHaveLength(1); // only the file check ran
    expect(v.passed).toBe(true);
  });

  it('an all-manual list can never machine-pass (no vacuous evidence)', async () => {
    const v = await runAcceptance([{ kind: 'manual', text: 'x' }], IO());
    expect(v.results).toHaveLength(0);
    expect(v.passed).toBe(false);
  });

  it('resolveWithinRoot refuses escapes and accepts the root itself', () => {
    expect(resolveWithinRoot('/proj', 'src/a.ts')).toBe('/proj/src/a.ts');
    expect(resolveWithinRoot('/proj', '.')).toBe('/proj');
    expect(resolveWithinRoot('/proj', '../other')).toBeNull();
    expect(resolveWithinRoot('/proj', '/etc/passwd')).toBeNull();
  });
});

describe('kernel.verifyTask — gated, recorded on the event log', () => {
  function seeded(verifyExec?: (run: string) => Promise<{ code: number }>) {
    const kernel = AmritaKernel.open({
      dbPath: ':memory:',
      ...(verifyExec ? { verifyExec: (run: string) => verifyExec(run) } : {}),
    });
    const projectId = kernel.ensureProject({ slug: 'v', name: 'V', root: '/tmp' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    const { taskId } = kernel.createTask({ projectId, conversationId, title: 'Ship it' });
    return { kernel, projectId, conversationId, taskId };
  }

  it('refuses a task with no machine-checkable criteria', async () => {
    const { kernel, projectId, conversationId, taskId } = seeded();
    await expect(kernel.verifyTask({ projectId, conversationId, taskId })).rejects.toThrow(
      /no machine-checkable/i,
    );
    kernel.close();
  });

  it('command checks NEVER run without an operator approval (deny → refused, exec untouched)', async () => {
    let ran = 0;
    const { kernel, projectId, conversationId, taskId } = seeded(async () => {
      ran++;
      return { code: 0 };
    });
    kernel.updateTask({
      projectId,
      conversationId,
      taskId,
      acceptance: [{ kind: 'command', run: 'pnpm test' }],
    });
    const attempt = kernel.verifyTask({ projectId, conversationId, taskId });
    await new Promise((r) => setTimeout(r, 20));
    const pending = kernel.listPendingApprovals();
    expect(pending[0]?.action).toBe('task.verify');
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'deny');
    await expect(attempt).rejects.toThrow(/not approved/i);
    expect(ran).toBe(0); // the command never executed
    kernel.close();
  });

  it('approved run executes, seals task.updated.verification, and stamps the row', async () => {
    const { kernel, projectId, conversationId, taskId } = seeded(async () => ({ code: 0 }));
    kernel.updateTask({
      projectId,
      conversationId,
      taskId,
      acceptance: [{ kind: 'command', run: 'pnpm test' }],
    });
    const attempt = kernel.verifyTask({ projectId, conversationId, taskId });
    await new Promise((r) => setTimeout(r, 20));
    kernel.resolveApproval(kernel.listPendingApprovals()[0]?.approvalId ?? '', 'allow');
    const out = await attempt;
    expect(out.passed).toBe(true);

    const task = kernel.listTasks({ projectId }).find((t) => t.id === taskId);
    expect(task?.verifiedAt).toBeTruthy();
    expect(JSON.parse(task?.verificationJson ?? '{}').passed).toBe(true);
    const ev = kernel
      .listEvents(conversationId, 0)
      .find(
        (e) =>
          e.type === 'task.updated' &&
          (e.payload as { verification?: unknown }).verification !== undefined,
      );
    expect(ev).toBeTruthy(); // the evidence rides the event log, not a side channel
    kernel.close();
  });

  it('file-only criteria run without any approval (read-only inside the root)', async () => {
    const { kernel, projectId, conversationId, taskId } = seeded();
    kernel.updateTask({
      projectId,
      conversationId,
      taskId,
      acceptance: [{ kind: 'file', path: 'no-such-file-xyz' }],
    });
    const out = await kernel.verifyTask({ projectId, conversationId, taskId });
    expect(kernel.listPendingApprovals()).toHaveLength(0);
    expect(out.passed).toBe(false); // honest: the file is missing
    kernel.close();
  });

  it('round-trips over the wire (tasks.verify result contract, ADR-0032)', async () => {
    const { kernel, projectId, conversationId, taskId } = seeded();
    kernel.updateTask({
      projectId,
      conversationId,
      taskId,
      acceptance: [{ kind: 'file', path: 'nope' }],
    });
    const r = await dispatch(kernel, {
      id: 1,
      method: 'tasks.verify',
      params: { projectId, conversationId, taskId },
    });
    expect(isErrorResponse(r)).toBe(false);
    if (!isErrorResponse(r)) {
      expect((r.result as { passed: boolean }).passed).toBe(false);
    }
    kernel.close();
  });

  it('refuses honestly when the project has no working folder bound', async () => {
    const kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const projectId = kernel.ensureProject({ slug: 'nr', name: 'NR' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    const { taskId } = kernel.createTask({ projectId, conversationId, title: 'T' });
    kernel.updateTask({
      projectId,
      conversationId,
      taskId,
      acceptance: [{ kind: 'file', path: 'x' }],
    });
    await expect(kernel.verifyTask({ projectId, conversationId, taskId })).rejects.toThrow(
      /working folder/i,
    );
    kernel.close();
  });
});
