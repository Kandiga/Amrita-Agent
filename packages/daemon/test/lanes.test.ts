import { FakeLaneRunner, ResearchLaneRunner } from '@amrita/lanes';
import { newId } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

let kernel: AmritaKernel;

function seedConversation(k: AmritaKernel): { projectId: string; conversationId: string } {
  const project = k.ensureProject({ slug: 'lanes', name: 'Lanes' });
  const conv = k.createConversation({ projectId: project.id });
  return { projectId: project.id, conversationId: conv.id };
}

function eventTypes(k: AmritaKernel, conversationId: string): string[] {
  return k.listEvents(conversationId).map((e) => e.type);
}

afterEach(() => kernel?.close());

describe('kernel lane orchestration', () => {
  it('records spawned + mandate on a dry run, without running', () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = seedConversation(kernel);
    return kernel.startLane({ conversationId, goal: 'tidy the repo', dryRun: true }).then((res) => {
      expect(res.dryRun).toBe(true);
      expect(res.status).toBe('spawned');
      expect(res.report).toBeNull();
      expect(eventTypes(kernel, conversationId)).toEqual(['lane.spawned', 'lane.mandate']);
      const lane = kernel.getLane(res.laneId);
      expect(lane?.status).toBe('spawned');
      expect(JSON.parse(lane?.mandateJson ?? '{}').goal).toBe('tidy the repo');
    });
  });

  it('creates one lane for concurrent retries carrying the same idempotency key', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { projectId, conversationId } = seedConversation(kernel);
    const request = {
      conversationId,
      goal: 'build once',
      dryRun: true,
      idempotencyKey: 'rpc:build-once',
    } as const;

    const [first, retry] = await Promise.all([
      kernel.startLane(request),
      kernel.startLane(request),
    ]);

    expect(retry.laneId).toBe(first.laneId);
    expect(kernel.listLanes({ projectId })).toHaveLength(1);
    expect(kernel.getLane(first.laneId)?.idempotencyKey).toBe(request.idempotencyKey);
    expect(eventTypes(kernel, conversationId)).toEqual(['lane.spawned', 'lane.mandate']);
  });

  it('fails closed when an idempotency key is reused for a different operation', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const first = seedConversation(kernel);
    const second = kernel.createConversation({ projectId: first.projectId });
    await kernel.startLane({
      conversationId: first.conversationId,
      goal: 'first operation',
      dryRun: true,
      idempotencyKey: 'rpc:owned-key',
    });

    await expect(
      kernel.startLane({
        conversationId: first.conversationId,
        goal: 'different operation',
        dryRun: true,
        idempotencyKey: 'rpc:owned-key',
      }),
    ).rejects.toThrow(/idempotency key.*different operation/i);
    await expect(
      kernel.startLane({
        conversationId: second.id,
        goal: 'first operation',
        dryRun: true,
        idempotencyKey: 'rpc:owned-key',
      }),
    ).rejects.toThrow(/idempotency key.*different operation/i);
  });

  it('treats the caller-requested jail as part of the idempotent identity', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = seedConversation(kernel);
    await kernel.startLane({
      conversationId,
      goal: 'scoped build',
      dryRun: true,
      idempotencyKey: 'rpc:scoped',
      scope: { paths: ['/tmp/a'] },
    });
    // Same key + same goal but a DIFFERENT explicit jail → a caller bug, not a reuse.
    await expect(
      kernel.startLane({
        conversationId,
        goal: 'scoped build',
        dryRun: true,
        idempotencyKey: 'rpc:scoped',
        scope: { paths: ['/tmp/b'] },
      }),
    ).rejects.toThrow(/idempotency key.*different operation/i);
    // The same jail (order-insensitive) still reuses.
    const reuse = await kernel.startLane({
      conversationId,
      goal: 'scoped build',
      dryRun: true,
      idempotencyKey: 'rpc:scoped',
      scope: { paths: ['/tmp/a'] },
    });
    expect(reuse.laneId).toBeTruthy();
  });

  it('reuses a no-scope idempotent lane on retry (the delegateTask path)', async () => {
    // delegateTask passes no explicit scope, so the stored jail is synthesized;
    // a retry must NOT be treated as a scope conflict against that synthesized jail.
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = seedConversation(kernel);
    const first = await kernel.startLane({
      conversationId,
      goal: 'delegate build',
      dryRun: true,
      idempotencyKey: 'delegate:TASK-9',
    });
    const retry = await kernel.startLane({
      conversationId,
      goal: 'delegate build',
      dryRun: true,
      idempotencyKey: 'delegate:TASK-9',
    });
    expect(retry.laneId).toBe(first.laneId);
  });

  it('correlates a QA lane with its build and refuses a foreign verification target', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const first = seedConversation(kernel);
    const groupId = newId();
    const build = await kernel.startLane({
      conversationId: first.conversationId,
      goal: 'build checkout',
      kind: 'claude-code',
      dryRun: true,
      groupId,
      role: 'build',
    });
    const qa = await kernel.startLane({
      conversationId: first.conversationId,
      goal: 'verify checkout',
      kind: 'codex',
      dryRun: true,
      groupId,
      role: 'qa',
      verifiesLaneId: build.laneId,
    });

    expect(kernel.getLane(build.laneId)).toMatchObject({ groupId, role: 'build' });
    expect(kernel.getLane(qa.laneId)).toMatchObject({
      groupId,
      role: 'qa',
      verifiesLaneId: build.laneId,
    });
    const qaSpawn = kernel
      .listEvents(first.conversationId)
      .find((event) => event.type === 'lane.spawned' && event.laneId === qa.laneId);
    expect(qaSpawn?.type === 'lane.spawned' && qaSpawn.payload).toMatchObject({
      groupId,
      role: 'qa',
      verifiesLaneId: build.laneId,
    });

    const otherProject = kernel.ensureProject({ slug: 'other', name: 'Other' });
    const otherConversation = kernel.createConversation({ projectId: otherProject.id });
    await expect(
      kernel.startLane({
        conversationId: otherConversation.id,
        goal: 'peek at foreign build',
        dryRun: true,
        role: 'qa',
        verifiesLaneId: build.laneId,
      }),
    ).rejects.toThrow(/verification target.*same project/i);
  });

  it('runs an injected fake runner end-to-end, emitting the full lifecycle', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({
        progress: [{ note: 'working', pct: 50 }],
        summary: 'rearranged the files',
        usage: { inputTokens: 12, outputTokens: 8 },
      }),
    });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({ conversationId, goal: 'refactor' });

    expect(res.status).toBe('completed');
    expect(res.report?.exit).toBe('done');
    expect(res.report?.summary).toBe('rearranged the files');
    expect(eventTypes(kernel, conversationId)).toEqual([
      'lane.spawned',
      'lane.mandate',
      'lane.progress',
      'lane.merge_report',
      'lane.completed',
    ]);
    const lane = kernel.getLane(res.laneId);
    expect(lane?.status).toBe('completed');
    expect(JSON.parse(lane?.mergeJson ?? '{}').exit).toBe('done');
  });

  it('surfaces a budget abort as exit:"budget"', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ spend: { tokens: 10_000 } }),
    });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({
      conversationId,
      goal: 'expensive job',
      budget: { maxTokens: 500 },
    });
    expect(res.report?.exit).toBe('budget');
    expect(res.status).toBe('completed'); // a budget stop is a completed (merged) lane, not aborted
  });

  it('ends safely as aborted when real execution is disabled (default runner)', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({ conversationId, goal: 'do real work' });
    expect(res.status).toBe('aborted');
    expect(res.report).toBeNull();
    expect(res.error).toMatch(/disabled/);
    expect(eventTypes(kernel, conversationId)).toEqual([
      'lane.spawned',
      'lane.mandate',
      'lane.aborted',
    ]);
    expect(kernel.getLane(res.laneId)?.status).toBe('aborted');
  });

  it('throws not_found for an unknown conversation', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    await expect(kernel.startLane({ conversationId: 'nope', goal: 'x' })).rejects.toThrow(
      /no such conversation/,
    );
  });
});

describe('lane rpc surface', () => {
  beforeEach(() => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ summary: 'done via rpc' }),
    });
  });

  async function call<T>(method: string, params?: unknown): Promise<T> {
    const r = await dispatch(kernel, { id: 1, method, params });
    if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as T;
  }

  it('starts, gets, and lists a lane over rpc (no secrets in the payloads)', async () => {
    const project = await call<{ id: string }>('project.ensure', { slug: 'p', name: 'P' });
    const conv = await call<{ id: string }>('conversation.create', { projectId: project.id });

    const started = await call<{ laneId: string; status: string; report: { exit: string } }>(
      'lanes.start',
      { conversationId: conv.id, goal: 'rpc lane', budget: { maxTokens: 1000 } },
    );
    expect(started.status).toBe('completed');
    expect(started.report.exit).toBe('done');

    const got = await call<{ id: string; status: string }>('lanes.get', {
      laneId: started.laneId,
    });
    expect(got.id).toBe(started.laneId);
    expect(got.status).toBe('completed');

    const list = await call<{ id: string }[]>('lanes.list', { projectId: project.id });
    expect(list.some((l) => l.id === started.laneId)).toBe(true);
  });

  it('rejects an over-long goal with invalid_params', async () => {
    const project = await call<{ id: string }>('project.ensure', { slug: 'q', name: 'Q' });
    const conv = await call<{ id: string }>('conversation.create', { projectId: project.id });
    const r = await dispatch(kernel, {
      id: 1,
      method: 'lanes.start',
      params: { conversationId: conv.id, goal: 'x'.repeat(5000) },
    });
    expect(isErrorResponse(r) && r.error.code).toBe('invalid_params');
  });

  it('accepts and bounds idempotency keys at the RPC boundary', async () => {
    const project = await call<{ id: string }>('project.ensure', { slug: 'idem', name: 'Idem' });
    const conv = await call<{ id: string }>('conversation.create', { projectId: project.id });
    const params = {
      conversationId: conv.id,
      goal: 'one rpc lane',
      dryRun: true,
      idempotencyKey: 'rpc:one-lane',
      groupId: newId(),
      role: 'build' as const,
    };
    const first = await call<{ laneId: string }>('lanes.start', params);
    const retry = await call<{ laneId: string }>('lanes.start', params);
    expect(retry.laneId).toBe(first.laneId);
    expect(kernel.getLane(first.laneId)).toMatchObject({
      groupId: params.groupId,
      role: 'build',
    });

    for (const idempotencyKey of ['', 'x'.repeat(201)]) {
      const response = await dispatch(kernel, {
        id: 1,
        method: 'lanes.start',
        params: { ...params, idempotencyKey },
      });
      expect(isErrorResponse(response) && response.error.code).toBe('invalid_params');
    }
  });

  it('rejects a malformed correlation id at the edge, before any side effect', async () => {
    const project = await call<{ id: string }>('project.ensure', { slug: 'corr', name: 'Corr' });
    const conv = await call<{ id: string }>('conversation.create', { projectId: project.id });
    // groupId/verifiesLaneId are lane IDs (ULIDs); a human-readable string must be
    // refused here — not deep inside the append transaction after a workspace dir
    // was already created (the outer and inner contracts must agree).
    for (const bad of [{ groupId: 'compare-run-1' }, { verifiesLaneId: 'not-a-ulid' }]) {
      const response = await dispatch(kernel, {
        id: 1,
        method: 'lanes.start',
        params: { conversationId: conv.id, goal: 'correlated build', dryRun: true, ...bad },
      });
      expect(isErrorResponse(response) && response.error.code).toBe('invalid_params');
    }
    // …and no lane was ever spawned for this conversation.
    expect(kernel.listLanes({}).filter((l) => l.conversationId === conv.id)).toHaveLength(0);
  });
});

describe('lane execution controls (WO#5.2)', () => {
  it('reports real execution disabled by default in health', () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    expect(kernel.realLaneExecution).toBe(false);
    expect(kernel.health().lanes.realExecution).toBe(false);
  });

  it('fails a real-execution request safely on a non-opted-in daemon (no run)', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({ conversationId, goal: 'do real work', real: true });
    expect(res.status).toBe('aborted');
    expect(res.report).toBeNull();
    expect(res.error).toMatch(/disabled/);
    // spawned + mandate + aborted — the runner was never invoked
    expect(eventTypes(kernel, conversationId)).toEqual([
      'lane.spawned',
      'lane.mandate',
      'lane.aborted',
    ]);
  });

  it('honours the opt-in flag and runs the (injected) runner for a real request', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneRunner: new FakeLaneRunner({ summary: 'ran for real' }),
    });
    expect(kernel.health().lanes.realExecution).toBe(true);
    const { conversationId } = seedConversation(kernel);
    // 'auto-safe' pre-authorizes this run; the default 'forward' policy would
    // gate it behind an operator approval (ADR-0021, covered in approvals.test).
    const res = await kernel.startLane({
      conversationId,
      goal: 'real',
      real: true,
      approvals: 'auto-safe',
    });
    expect(res.status).toBe('completed');
    expect(res.report?.summary).toBe('ran for real');
  });

  it('detaches a lane and cancels it, transitioning to cancelled', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ block: true }),
    });
    const { conversationId } = seedConversation(kernel);
    const started = await kernel.startLane({ conversationId, goal: 'long job', detach: true });
    expect(started.detached).toBe(true);
    expect(started.status).toBe('running');
    expect(kernel.health().lanes.active).toBe(1);

    const cancel = await kernel.cancelLane(started.laneId);
    expect(cancel.cancelled).toBe(true);
    expect(cancel.status).toBe('aborted'); // row status; merge report carries exit:'cancelled'
    const lane = kernel.getLane(started.laneId);
    expect(JSON.parse(lane?.mergeJson ?? '{}').exit).toBe('cancelled');
    expect(eventTypes(kernel, conversationId)).toContain('lane.aborted');
    expect(kernel.health().lanes.active).toBe(0);
  });

  it('reports cancel of a non-active lane without error', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const res = await kernel.cancelLane('LANEDOESNOTEXIST');
    expect(res.cancelled).toBe(false);
    expect(res.status).toBeNull();
  });

  it('exposes lanes.cancel over rpc', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ block: true }),
    });
    const { conversationId } = seedConversation(kernel);
    const started = await kernel.startLane({ conversationId, goal: 'job', detach: true });
    const r = await dispatch(kernel, {
      id: 1,
      method: 'lanes.cancel',
      params: { laneId: started.laneId },
    });
    expect(isErrorResponse(r)).toBe(false);
    if (!isErrorResponse(r)) {
      expect((r.result as { cancelled: boolean }).cancelled).toBe(true);
    }
  });
});

describe('lane kind routing (ADR-0023)', () => {
  it('research lanes without a provider abort honestly via the unwired seam', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({
      conversationId,
      goal: 'find fts5 sources',
      kind: 'research',
    });
    expect(res.status).toBe('aborted');
    expect(res.report?.exit).toBe('aborted');
    expect(res.report?.summary).toContain('no search provider is configured');
  });

  it('an injected research runner with a fake provider completes with sources', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      extraLaneRunners: [
        new ResearchLaneRunner({
          provider: {
            id: 'fake',
            search: async () => [{ title: 'FTS5 docs', url: 'https://sqlite.org/fts5.html' }],
          },
        }),
      ],
    });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({
      conversationId,
      goal: 'find fts5 sources',
      kind: 'research',
    });
    expect(res.status).toBe('completed');
    expect(res.report?.followUps).toEqual(['FTS5 docs — https://sqlite.org/fts5.html']);
    // the full lifecycle is in the log, like every other lane kind
    const types = eventTypes(kernel, conversationId);
    expect(types).toContain('lane.progress');
    expect(types).toContain('lane.merge_report');
    expect(types).toContain('lane.completed');
  });

  it('an unknown lane kind aborts honestly instead of running the default runner', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ summary: 'must never run' }),
    });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({ conversationId, goal: 'x', kind: 'gemini-cli' });
    expect(res.status).toBe('aborted');
    expect(res.error).toContain('no runner registered for lane kind: gemini-cli');
    // no merge report: nothing executed
    expect(eventTypes(kernel, conversationId)).not.toContain('lane.merge_report');
  });

  it('the default kind still routes to the injected default runner (no behavior drift)', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: new FakeLaneRunner({ summary: 'default path intact' }),
    });
    const { conversationId } = seedConversation(kernel);
    const res = await kernel.startLane({ conversationId, goal: 'x' });
    expect(res.status).toBe('completed');
    expect(res.report?.summary).toBe('default path intact');
  });
});
