import { FakeLaneRunner } from '@amrita/lanes';
import { afterEach, describe, expect, it } from 'vitest';
import { AmritaKernel, dispatch, isErrorResponse } from '../src/index.ts';

/**
 * Operator approvals (ADR-0021): deny-by-default supervision for dangerous
 * actions. A REAL lane run under the default 'forward' policy waits for an
 * explicit operator allow; deny, timeout, and cancel all refuse safely, and
 * every outcome is audited as approval.* events.
 */

let kernel: AmritaKernel;
afterEach(() => kernel?.close());

function seed(k: AmritaKernel): { projectId: string; conversationId: string } {
  const projectId = k.ensureProject({ slug: 'appr', name: 'Approvals' }).id;
  const conversationId = k.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

describe('operator approvals (ADR-0021)', () => {
  it('a real run under forward policy waits, then proceeds on ALLOW (resolved over RPC)', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneRunner: new FakeLaneRunner({ summary: 'approved work' }),
    });
    const { conversationId } = seed(kernel);
    const started = await kernel.startLane({
      conversationId,
      goal: 'risky real change',
      real: true,
      detach: true, // returns immediately; the lane waits on the approval
    });
    expect(started.status).toBe('running');

    // the request is pending and visible to operators
    const pending =
      await call<{ approvalId: string; action: string; detail?: string }[]>('approvals.list');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ action: 'lane.run-real', detail: 'risky real change' });

    // allow it over the operator surface
    const resolved = await call<{ resolved: boolean }>('approvals.resolve', {
      approvalId: pending[0]?.approvalId,
      decision: 'allow',
    });
    expect(resolved.resolved).toBe(true);
    await kernel.awaitLane(started.laneId);
    expect(kernel.getLane(started.laneId)?.status).toBe('completed');

    // full audit trail in the log: requested then resolved(allow)
    const types = kernel.listEvents(conversationId).map((e) => e.type);
    expect(types).toContain('approval.requested');
    expect(types).toContain('approval.resolved');
    const resolvedEv = kernel
      .listEvents(conversationId)
      .find((e) => e.type === 'approval.resolved') as unknown as {
      payload: { decision: string };
    };
    expect(resolvedEv.payload.decision).toBe('allow');
    expect(await call('approvals.list')).toEqual([]); // nothing left pending
  });

  it('DENY refuses the run; the lane aborts with the reason and nothing executes', async () => {
    const runner = new FakeLaneRunner({ summary: 'should never run' });
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneRunner: runner,
    });
    const { conversationId } = seed(kernel);
    const started = await kernel.startLane({
      conversationId,
      goal: 'denied change',
      real: true,
      detach: true,
    });
    const [pending] = kernel.listPendingApprovals();
    kernel.resolveApproval(pending?.approvalId ?? '', 'deny');
    await kernel.awaitLane(started.laneId);

    expect(kernel.getLane(started.laneId)?.status).toBe('aborted');
    const aborted = kernel
      .listEvents(conversationId)
      .find((e) => e.type === 'lane.aborted') as unknown as { payload: { reason: string } };
    expect(aborted.payload.reason).toContain('denied by operator');
    // no merge report — the runner never ran
    expect(kernel.listEvents(conversationId).some((e) => e.type === 'lane.merge_report')).toBe(
      false,
    );
  });

  it('TIMEOUT denies by default and audits the deny', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneRunner: new FakeLaneRunner({ summary: 'never' }),
      approvalTimeoutMs: 30, // bounded for the test
    });
    const { conversationId } = seed(kernel);
    const started = await kernel.startLane({
      conversationId,
      goal: 'forgotten request',
      real: true,
      detach: true,
    });
    await kernel.awaitLane(started.laneId);
    expect(kernel.getLane(started.laneId)?.status).toBe('aborted');
    const events = kernel.listEvents(conversationId);
    const aborted = events.find((e) => e.type === 'lane.aborted') as unknown as {
      payload: { reason: string };
    };
    expect(aborted.payload.reason).toContain('timed out');
    const resolvedEv = events.find((e) => e.type === 'approval.resolved') as unknown as {
      payload: { decision: string };
    };
    expect(resolvedEv.payload.decision).toBe('deny'); // timeout audits as deny
  });

  it('cancelling a lane that awaits approval refuses cleanly', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneRunner: new FakeLaneRunner({ summary: 'never' }),
    });
    const { conversationId } = seed(kernel);
    const started = await kernel.startLane({
      conversationId,
      goal: 'cancel me',
      real: true,
      detach: true,
    });
    expect(kernel.listPendingApprovals()).toHaveLength(1);
    const cancel = await kernel.cancelLane(started.laneId);
    expect(cancel.cancelled).toBe(true);
    expect(kernel.getLane(started.laneId)?.status).toBe('aborted');
    expect(kernel.listPendingApprovals()).toEqual([]);
  });

  it('safe runs are NOT gated: dry-run and non-real starts never create approvals', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ summary: 'safe' }),
    });
    const { conversationId } = seed(kernel);
    await kernel.startLane({ conversationId, goal: 'dry', dryRun: true });
    await kernel.startLane({ conversationId, goal: 'safe fake run' });
    expect(kernel.listPendingApprovals()).toEqual([]);
    expect(kernel.listEvents(conversationId).some((e) => e.type === 'approval.requested')).toBe(
      false,
    );
  });

  it('closes the bypass: on an opted-in daemon a start WITHOUT real:true is still gated', async () => {
    // The runner on an opted-in daemon executes for real whether or not the
    // caller passed `real: true` — so the gate must key on daemon posture.
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneRunner: new FakeLaneRunner({ summary: 'must wait for approval' }),
    });
    const { conversationId } = seed(kernel);
    const started = await kernel.startLane({
      conversationId,
      goal: 'sneaky run without the real flag',
      detach: true,
    });
    expect(kernel.listPendingApprovals()).toHaveLength(1); // gated, not running free
    kernel.resolveApproval(kernel.listPendingApprovals()[0]?.approvalId ?? '', 'deny');
    await new Promise((r) => setTimeout(r, 10));
    expect(kernel.getLane(started.laneId)?.status).toBe('aborted');
    // dry runs on the same opted-in daemon stay ungated
    await kernel.startLane({ conversationId, goal: 'dry', dryRun: true });
    expect(kernel.listPendingApprovals()).toEqual([]);
  });

  it('resolving an unknown or settled approval reports resolved:false', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    expect(kernel.resolveApproval('NOSUCH', 'allow')).toEqual({
      approvalId: 'NOSUCH',
      resolved: false,
    });
  });
});
