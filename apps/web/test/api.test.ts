import { describe, expect, it } from 'vitest';
import { RpcClient, RpcError } from '../src/api.ts';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe('RpcClient', () => {
  it('posts json-rpc calls through the injected fetch', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new RpcClient({
      baseUrl: 'http://amrita.local',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ result: { ok: true } });
      }) as typeof fetch,
    });

    await expect(client.call('health')).resolves.toEqual({ ok: true });
    expect(calls[0]?.url).toBe('http://amrita.local/rpc');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ method: 'health' });
  });

  it('throws structured value-free rpc errors', async () => {
    const client = new RpcClient({
      fetchImpl: (async () =>
        jsonResponse({
          error: { code: 'provider_unavailable', message: 'Provider unavailable' },
        })) as typeof fetch,
    });

    await expect(client.call('chat.turn')).rejects.toMatchObject({ code: 'provider_unavailable' });
    try {
      await client.call('chat.turn');
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(String(e)).not.toMatch(/sk-|secret|token/i);
    }
  });

  it('loads replay events by conversation id and since sequence', async () => {
    const client = new RpcClient({
      baseUrl: '/api',
      fetchImpl: (async (url) => {
        expect(String(url)).toContain('/api/events?conversationId=c1&sinceSeq=7');
        return jsonResponse({
          events: [
            { id: 'e1', seq: 8, ts: 'now', type: 'message.user', payload: { text: 'hello' } },
          ],
        });
      }) as typeof fetch,
    });

    await expect(client.events('c1', 7)).resolves.toHaveLength(1);
  });

  it('sends an Authorization header only once a token is set', async () => {
    const headers: Array<Record<string, string>> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return jsonResponse({ result: {} });
      }) as typeof fetch,
    });
    await client.call('health'); // no token yet
    expect(client.hasAuthToken()).toBe(false);
    client.setAuthToken('tok-123');
    await client.call('health'); // token set
    expect(headers[0]?.authorization).toBeUndefined();
    expect(headers[1]?.authorization).toBe('Bearer tok-123');
  });

  it('throws a value-free unauthorized error on 401', async () => {
    const client = new RpcClient({
      fetchImpl: (async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: { code: 'unauthorized', message: 'no' } }),
      })) as unknown as typeof fetch,
    });
    await expect(client.call('health')).rejects.toMatchObject({ code: 'unauthorized' });
    try {
      await client.call('health');
    } catch (e) {
      expect(String(e)).not.toMatch(/tok-|Bearer/);
    }
  });

  it('sends typed project-knowledge RPC payloads (tasks/decisions/memory)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ result: {} });
      }) as typeof fetch,
    });
    const ctx = { projectId: 'P1', conversationId: 'C1' };
    await client.tasksCreate({ ...ctx, title: 'ship it' });
    await client.tasksComplete({ ...ctx, taskId: 'T1' });
    await client.decisionsRecord({ ...ctx, text: 'use ulids' });
    await client.decisionsList({ projectId: 'P1' });
    await client.memoryPut({ ...ctx, scope: 'project', content: 'remember this' });
    expect(bodies.map((b) => b.method)).toEqual([
      'tasks.create',
      'tasks.complete',
      'decisions.record',
      'decisions.list',
      'memory.put',
    ]);
    expect(bodies[0]?.params).toMatchObject({ ...ctx, title: 'ship it' });
    expect(bodies[4]?.params).toMatchObject({ scope: 'project', content: 'remember this' });
  });

  it('sends typed runtime-selection RPC payloads (status/set/clear)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ result: {} });
      }) as typeof fetch,
    });
    await client.runtimeStatus('P1');
    await client.runtimeStatus();
    await client.roleSet({ role: 'main', provider: 'mock', model: 'm1', projectId: 'P1' });
    await client.roleClear({ role: 'main', projectId: 'P1' });
    await client.roleClear({ role: 'deep' });
    expect(bodies.map((b) => b.method)).toEqual([
      'runtime.status',
      'runtime.status',
      'providers.role.set',
      'providers.role.clear',
      'providers.role.clear',
    ]);
    expect(bodies[0]?.params).toEqual({ projectId: 'P1' });
    expect(bodies[1]?.params).toEqual({});
    expect(bodies[2]?.params).toMatchObject({ role: 'main', provider: 'mock', projectId: 'P1' });
    expect(bodies[4]?.params).toEqual({ role: 'deep' });
  });

  it('sends typed companion RPC payloads (brief/questions/risks/milestones/timeline)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return jsonResponse({ result: {} });
      }) as typeof fetch,
    });
    const ctx = { projectId: 'P1', conversationId: 'C1' };
    await client.companionGet('P1');
    await client.briefUpdate({ ...ctx, goal: 'ship it', successCriteria: ['works'] });
    await client.questionOpen({ ...ctx, text: 'which auth?' });
    await client.questionResolve({ ...ctx, questionId: 'Q1', resolution: 'magic links' });
    await client.questionDrop({ ...ctx, questionId: 'Q2', reason: 'out of scope' });
    await client.riskOpen({ ...ctx, text: 'data loss', severity: 'high' });
    await client.milestoneCreate({ ...ctx, title: 'Alpha', targetDate: '2026-07-01' });
    await client.milestoneComplete({ ...ctx, milestoneId: 'M1' });
    await client.timelineList('P1', 30);
    expect(bodies.map((b) => b.method)).toEqual([
      'projects.companion.get',
      'projects.brief.update',
      'projects.questions.open',
      'projects.questions.resolve',
      'projects.questions.drop',
      'projects.risks.open',
      'projects.milestones.create',
      'projects.milestones.complete',
      'projects.timeline.list',
    ]);
    expect(bodies[1]?.params).toMatchObject({ goal: 'ship it', successCriteria: ['works'] });
    expect(bodies[5]?.params).toMatchObject({ severity: 'high' });
    expect(bodies[8]?.params).toMatchObject({ projectId: 'P1', limit: 30 });
  });

  it('sends typed lane RPC payloads with the auth header', async () => {
    const calls: Array<{
      body: { method: string; params: unknown };
      headers: Record<string, string>;
    }> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ result: { laneId: 'L1', status: 'running' } });
      }) as typeof fetch,
    });
    client.setAuthToken('tok-1');
    await client.lanesStart({
      conversationId: 'c1',
      goal: 'tidy',
      dryRun: false,
      real: true,
      detach: true,
      budget: { maxTurns: 3 },
    });
    await client.lanesCancel('L1');
    expect(calls[0]?.body).toMatchObject({
      method: 'lanes.start',
      params: {
        conversationId: 'c1',
        goal: 'tidy',
        real: true,
        detach: true,
        budget: { maxTurns: 3 },
      },
    });
    expect(calls[0]?.headers.authorization).toBe('Bearer tok-1');
    expect(calls[1]?.body).toMatchObject({ method: 'lanes.cancel', params: { laneId: 'L1' } });
  });
});
