import { rpcResultSchemas } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';
import type { FetchLike } from '../src/provider.ts';
import { METHODS, dispatch, isErrorResponse } from '../src/rpc.ts';
import type { CommandProber } from '../src/runtimes.ts';

/**
 * ADR-0032 fitness functions:
 *  1. the METHODS registry and the protocol's `rpcResultSchemas` cover each
 *     other exactly — adding an RPC method without a wire contract fails here;
 *  2. every coverable method round-trips through dispatch against a real
 *     kernel and passes its result contract (dispatch parses on the way out —
 *     a mismatch surfaces as a `result contract violation` internal error).
 *
 * The three cinema proxy verbs are excluded from the round-trip: their results
 * are module-owned (`z.unknown()`) and require the live brain-bridge.
 */

const fakeFetch: FetchLike = async (url) => {
  const u = String(url);
  if (u.includes('api.github.com')) {
    return new Response(
      JSON.stringify([
        {
          number: 7,
          title: 'Crash on save',
          html_url: 'https://github.com/o/r/issues/7',
          state: 'open',
        },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  // Everything else (rate_limit probes, /models discovery): honest failure.
  return new Response('{}', { status: 500 });
};

/** A bounded fake prober: every CLI is "not found" — honest, deterministic. */
const fakeProber: CommandProber = async () => ({ kind: 'spawn_error' });

let kernel: AmritaKernel;

beforeEach(() => {
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    fetchImpl: fakeFetch,
    codingRuntimeProber: fakeProber,
    cliExec: () => ({ status: 1, stdout: '', stderr: 'not available' }),
  });
});
afterEach(() => {
  kernel.close();
  vi.unstubAllEnvs();
});

async function call(method: string, params?: unknown): Promise<unknown> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r.result;
}

describe('wire-contract coverage (ADR-0032)', () => {
  it('every RPC method has a protocol result schema and vice versa', () => {
    const methods = Object.keys(METHODS).sort();
    const contracts = Object.keys(rpcResultSchemas).sort();
    expect(methods).toEqual(contracts);
  });
});

describe('wire-contract round-trip (ADR-0032)', () => {
  it('every coverable method round-trips through its result contract', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_clearly_fake_test_fixture');

    // Excluded: module-owned opaque proxies that need the live cinema bridge.
    const excluded = new Set(['cinema.chat', 'cinema.assetAnalysis', 'cinema.providers']);
    const exercised = new Set<string>(excluded);
    const run = async (method: string, params?: unknown): Promise<unknown> => {
      exercised.add(method);
      return call(method, params);
    };

    await run('ping');
    await run('health');

    const p = (await run('project.ensure', { slug: 'wire', name: 'Wire' })) as { id: string };
    await run('project.get', { slug: 'wire' });
    await run('project.list');

    const c = (await run('conversation.create', { projectId: p.id })) as { id: string };
    await run('conversation.get', { conversationId: c.id });
    await run('conversation.list', { projectId: p.id });
    await run('conversation.tree', { conversationId: c.id });
    const ctx = { projectId: p.id, conversationId: c.id };

    await run('message.user.record', { ...ctx, text: 'hello wire', channel: 'api' });
    await run('events.list', { conversationId: c.id });

    const t = (await run('tasks.create', { ...ctx, title: 'prove the contract' })) as {
      taskId: string;
    };
    await run('tasks.list', { projectId: p.id });
    await run('tasks.complete', { ...ctx, taskId: t.taskId });

    await run('projects.brief.update', { ...ctx, goal: 'close the wire' });
    await run('projects.brand.update', { ...ctx, name: 'Amrita' });
    await run('projects.previews.approve', {
      ...ctx,
      previewId: 'html-preview:x',
      contentHash: 'abc123',
    });
    const q = (await run('projects.questions.open', { ...ctx, text: 'is it typed?' })) as {
      questionId: string;
    };
    await run('projects.questions.resolve', {
      ...ctx,
      questionId: q.questionId,
      resolution: 'yes',
    });
    const q2 = (await run('projects.questions.open', { ...ctx, text: 'drop me' })) as {
      questionId: string;
    };
    await run('projects.questions.drop', { ...ctx, questionId: q2.questionId, reason: 'test' });
    const r1 = (await run('projects.risks.open', { ...ctx, text: 'drift', severity: 'high' })) as {
      riskId: string;
    };
    await run('projects.risks.resolve', { ...ctx, riskId: r1.riskId, resolution: 'schemas' });
    const r2 = (await run('projects.risks.open', { ...ctx, text: 'drop me too' })) as {
      riskId: string;
    };
    await run('projects.risks.drop', { ...ctx, riskId: r2.riskId, reason: 'test' });
    const m = (await run('projects.milestones.create', { ...ctx, title: 'R0' })) as {
      milestoneId: string;
    };
    await run('projects.milestones.update', {
      ...ctx,
      milestoneId: m.milestoneId,
      status: 'active',
    });
    await run('projects.milestones.complete', { ...ctx, milestoneId: m.milestoneId });
    await run('projects.companion.get', { projectId: p.id });
    await run('projects.timeline.list', { projectId: p.id });

    await run('decisions.record', { ...ctx, text: 'wire contracts are law' });
    await run('decisions.list', { projectId: p.id });

    await run('memory.put', { ...ctx, scope: 'project', content: 'contract notes' });
    await run('memory.search', { query: 'contract' });

    await run('settings.update', { ...ctx, key: 'theme', value: 'dark' });
    await run('settings.get', { key: 'theme' });

    const acc = (await run('accounts.connect', {
      ...ctx,
      provider: 'anthropic',
      authMode: 'api_key',
    })) as { accountId: string };
    await run('accounts.list');
    await run('accounts.bindSecretRef', { accountId: acc.accountId, envName: 'ANTHROPIC_API_KEY' });
    await run('accounts.configStatus', { accountId: acc.accountId });

    await run('connectors.list');
    await run('connectors.status');
    await run('github.importIssues', { ...ctx, repo: 'o/r' });

    const lane = (await run('lanes.start', {
      conversationId: c.id,
      goal: 'dry',
      dryRun: true,
    })) as {
      laneId: string;
    };
    await run('lanes.list', { projectId: p.id });
    await run('lanes.get', { laneId: lane.laneId });
    await run('lanes.cancel', { laneId: lane.laneId });

    await run('approvals.list');
    await run('approvals.resolve', { approvalId: lane.laneId, decision: 'deny' });

    await run('chat.turn', { conversationId: c.id, text: 'hello', provider: 'mock' });

    await run('runtime.status', { projectId: p.id });
    await run('providers.role.set', { role: 'main', provider: 'mock' });
    await run('providers.roles', { projectId: p.id });
    await run('providers.role.clear', { role: 'main' });
    await run('providers.list');
    await run('providers.catalog');
    await run('providers.models', { provider: 'openai' });
    await run('providers.probeEndpoint', { baseUrl: 'http://localhost:9' });

    await run('harness.topology');
    await run('harness.sources', { projectId: p.id });
    await run('harness.brain', { projectId: p.id });
    await run('harness.capture', { ...ctx, title: 'captured fact', kind: 'project-context' });

    await run('channels.list');
    await run('channels.pairing.create', { projectId: p.id });
    await run('channels.pairing.list', {});

    const mandate = (await run('cinema.mandate.issue', { ...ctx, goal: 'render intro' })) as {
      mandateId: string;
    };
    await run('cinema.mandate.list', { conversationId: c.id });
    await run('cinema.mandate.complete', {
      ...ctx,
      report: { mandateId: mandate.mandateId, exit: 'done', summary: 'rendered' },
    });

    // R1 verbs (ADR-0033/0034/0035)
    await run('projects.context', { projectId: p.id });
    await run('skills.list', { projectId: p.id });
    const c2 = (await call('conversation.create', { projectId: p.id, title: 'long one' })) as {
      id: string;
    };
    await call('message.user.record', {
      projectId: p.id,
      conversationId: c2.id,
      text: 'compress me',
    });
    await run('conversation.compress', { conversationId: c2.id });

    // R6 (ADR-0037)
    await run('operator.command', { projectId: p.id, text: '/help' });

    // R3 verbs (ADR-0036)
    await run('system.health');
    await run('system.audit', { record: true });
    await run('system.plan', { projectId: p.id, title: 'wire the plan' });
    await run('system.manage', { projectId: p.id, goal: 'dry goal', dryRun: true });

    await run('doctor');

    const missed = Object.keys(METHODS).filter((m2) => !exercised.has(m2));
    expect(missed, `methods not exercised: ${missed.join(', ')}`).toEqual([]);
  }, 30_000);
});
