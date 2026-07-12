import { newId } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import { RpcClient, RpcError } from '../src/api.ts';

/**
 * Since ADR-0032 the client parses every response through the protocol's wire
 * contract, so these fixtures must be contract-valid — a fixture that would
 * not parse is exactly the drift this layer now catches.
 */

const ULID = newId();

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

/** Minimal contract-valid results for the methods these tests exercise. */
function resultFor(method: string): unknown {
  switch (method) {
    case 'health':
      return {
        ok: true,
        name: 'amritad',
        startedAt: '2026-07-11T10:00:00.000Z',
        dbPath: ':memory:',
        schemaVersion: 6,
        counts: { projects: 0, conversations: 0, messages: 0, events: 0 },
        lanes: { realExecution: false, active: 0 },
      };
    case 'tasks.create':
      return { taskId: ULID };
    case 'tasks.complete':
    case 'projects.brand.update':
    case 'projects.previews.approve':
    case 'projects.brief.update':
    case 'projects.questions.resolve':
    case 'projects.questions.drop':
    case 'projects.milestones.complete':
    case 'providers.role.set':
    case 'providers.role.clear':
      return { ok: true };
    case 'decisions.record':
      return { decisionId: ULID };
    case 'decisions.list':
    case 'connectors.status':
    case 'harness.sources':
    case 'projects.timeline.list':
      return [];
    case 'memory.put':
      return { entryId: ULID };
    case 'runtime.status':
      return { roles: [], providers: [], codingRuntimes: [] };
    case 'providers.catalog':
      return [
        {
          id: 'anthropic',
          title: 'Anthropic',
          group: 'api_key',
          authMode: 'api_key',
          defaultModel: 'claude-sonnet-4-5',
          executable: true,
          state: 'needs_key',
          detail: 'no key configured',
        },
      ];
    case 'harness.topology':
      return {
        version: 1,
        agents: [
          {
            id: 'capture',
            role: 'ingest',
            title: 'Manual capture',
            trigger: 'user action',
            outputs: ['knowledge records'],
            qualityChecks: ['provenance present'],
            status: 'active',
          },
        ],
      };
    case 'harness.brain':
      return {
        projectId: ULID,
        records: [],
        gaps: [],
        sources: [],
        maintenance: [],
        counts: { records: 0, gaps: 0, sourcesConnected: 0, sourcesManual: 0, sourcesPlanned: 0 },
      };
    case 'harness.capture':
      return { entryId: ULID, kind: 'commitment' };
    case 'github.importIssues':
      return { repo: 'octo/repo', imported: 0, skipped: 0, total: 0, tasks: [] };
    case 'projects.companion.get':
      return {
        brief: null,
        brand: null,
        questions: [],
        risks: [],
        milestones: [],
        previewApprovals: [],
      };
    case 'projects.questions.open':
      return { questionId: ULID };
    case 'projects.risks.open':
      return { riskId: ULID };
    case 'projects.milestones.create':
      return { milestoneId: ULID };
    case 'lanes.start':
      return { laneId: ULID, status: 'running', dryRun: false, detached: true, report: null };
    case 'lanes.cancel':
      return { laneId: ULID, cancelled: true, status: null };
    default:
      return {};
  }
}

/** A fake fetch that records request bodies and answers contract-valid results. */
function contractFetch(record: Array<{ method: string; params: unknown }>) {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown };
    record.push({ method: body.method, params: body.params });
    return jsonResponse({ id: body.id, result: resultFor(body.method) });
  }) as typeof fetch;
}

describe('RpcClient', () => {
  it('posts json-rpc calls through the injected fetch and parses the result contract', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = new RpcClient({
      baseUrl: 'http://amrita.local',
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ id: 1, result: resultFor('health') });
      }) as typeof fetch,
    });

    await expect(client.call('health')).resolves.toMatchObject({ ok: true, name: 'amritad' });
    expect(calls[0]?.url).toBe('http://amrita.local/rpc');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ method: 'health' });
  });

  it('rejects a result that violates the wire contract (ADR-0032)', async () => {
    const client = new RpcClient({
      fetchImpl: (async () => jsonResponse({ id: 1, result: { notHealth: true } })) as typeof fetch,
    });
    await expect(client.call('health')).rejects.toThrow();
  });

  it('throws structured value-free rpc errors', async () => {
    const client = new RpcClient({
      fetchImpl: (async () =>
        jsonResponse({
          id: 1,
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
    const ev = {
      id: newId(),
      seq: 8,
      ts: '2026-07-11T10:00:00.000Z',
      projectId: newId(),
      conversationId: newId(),
      origin: 'user',
      type: 'message.user',
      payload: { text: 'hello' },
    };
    const client = new RpcClient({
      baseUrl: '/api',
      fetchImpl: (async (url) => {
        expect(String(url)).toContain('/api/events?conversationId=c1&sinceSeq=7');
        return jsonResponse({ events: [ev] });
      }) as typeof fetch,
    });

    await expect(client.events('c1', 7)).resolves.toHaveLength(1);
  });

  it('sends an Authorization header only once a token is set', async () => {
    const headers: Array<Record<string, string>> = [];
    const client = new RpcClient({
      fetchImpl: (async (_url, init) => {
        headers.push((init?.headers ?? {}) as Record<string, string>);
        return jsonResponse({ id: 1, result: resultFor('health') });
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
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
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

  it('sends typed brand + preview-approval RPC payloads', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
    const ctx = { projectId: 'P1', conversationId: 'C1' };
    await client.brandUpdate({ ...ctx, name: 'Nimbus', palette: ['#0EA5E9 cyan'] });
    await client.previewApprove({ ...ctx, previewId: 'html-preview:P1', contentHash: 'abc123' });
    expect(bodies.map((b) => b.method)).toEqual([
      'projects.brand.update',
      'projects.previews.approve',
    ]);
    expect(bodies[0]?.params).toMatchObject({ name: 'Nimbus', palette: ['#0EA5E9 cyan'] });
    expect(bodies[1]?.params).toMatchObject({
      previewId: 'html-preview:P1',
      contentHash: 'abc123',
    });
  });

  it('sends typed runtime-selection RPC payloads (status/set/clear)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
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

  it('fetches the provider catalog through providers.catalog', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
    const catalog = await client.providersCatalog();
    expect(bodies[0]?.method).toBe('providers.catalog');
    expect(bodies[0]?.params).toEqual({});
    expect(catalog[0]).toMatchObject({ id: 'anthropic', state: 'needs_key' });
  });

  it('sends typed brain-harness RPC payloads (ADR-0027)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
    await client.harnessTopology();
    await client.harnessSources();
    await client.harnessBrain('P1');
    await client.harnessCapture({
      projectId: 'P1',
      conversationId: 'C1',
      kind: 'commitment',
      title: 'Ship it',
      owner: 'nethanel',
      tags: ['release'],
    });
    expect(bodies.map((b) => b.method)).toEqual([
      'harness.topology',
      'harness.sources',
      'harness.brain',
      'harness.capture',
    ]);
    expect(bodies[2]?.params).toEqual({ projectId: 'P1' });
    expect(bodies[3]?.params).toMatchObject({
      kind: 'commitment',
      title: 'Ship it',
      owner: 'nethanel',
      tags: ['release'],
    });
  });

  it('sends typed connector + github-import RPC payloads (ADR-0022)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
    await client.connectorsStatus();
    await client.githubImport({
      projectId: 'P1',
      conversationId: 'C1',
      repo: 'octo/repo',
      limit: 25,
    });
    expect(bodies.map((b) => b.method)).toEqual(['connectors.status', 'github.importIssues']);
    // web provenance: the import is stamped channel: web
    expect(bodies[1]?.params).toEqual({
      projectId: 'P1',
      conversationId: 'C1',
      repo: 'octo/repo',
      limit: 25,
      channel: 'web',
    });
  });

  it('sends typed companion RPC payloads (brief/questions/risks/milestones/timeline)', async () => {
    const bodies: Array<{ method: string; params: unknown }> = [];
    const client = new RpcClient({ fetchImpl: contractFetch(bodies) });
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
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        calls.push({
          body: body as unknown as { method: string; params: unknown },
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        return jsonResponse({ id: body.id, result: resultFor(body.method) });
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
