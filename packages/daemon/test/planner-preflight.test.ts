import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_EXECUTION_FIX, blockedOrchestratorPreamble } from '../src/context-pack.ts';
import { AmritaKernel, type FetchLike, type FetchResponseLike } from '../src/index.ts';

/**
 * QA finding 1 (false-ready dead end): on a fresh install (real execution OFF)
 * the reply used to PROMISE "the session is waiting for your approval — the
 * Allow button appears…" while the planner silently returned: no session, no
 * approval, no trace. The fix is two-sided and both sides are pinned here:
 *  1. the per-turn preamble tells the model the truth (blocked variant), and
 *  2. the planner parks the request as ONE actionable Inbox card.
 */

let kernel: AmritaKernel;
let dir: string;
let ctx: { projectId: string; conversationId: string };
/** Every provider request body, so tests can read the system preamble actually sent. */
let providerBodies: string[];

const capturingChat: FetchLike = async (_url, init): Promise<FetchResponseLike> => {
  providerBodies.push(typeof init?.body === 'string' ? init.body : '');
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        content: [{ type: 'text', text: 'understood.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    },
    async text() {
      return '';
    },
  };
};

beforeEach(() => {
  providerBodies = [];
  dir = mkdtempSync(join(tmpdir(), 'amrita-preflight-'));
  process.env.ANTHROPIC_API_KEY = 'placeholder-value-for-tests';
  // A FRESH INSTALL: real execution off (the safe default), no session runners.
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    fetchImpl: capturingChat,
    codingRuntimeProber: async () => ({ kind: 'ok', stdout: '2.1.0', stderr: '' }),
  });
  const projectId = kernel.ensureProject({ slug: 'p', name: 'P' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
  const { accountId } = kernel.connectProviderAccount({
    projectId,
    conversationId,
    provider: 'anthropic',
    authMode: 'api_key',
  });
  kernel.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
});

afterEach(() => {
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
  for (const name of ['ANTHROPIC_API_KEY']) delete process.env[name];
});

const turn = (text: string) =>
  kernel.runChatTurn({ conversationId: ctx.conversationId, text, provider: 'anthropic' });

const spawnedLanes = () =>
  kernel.listEvents(ctx.conversationId, 0).filter((e) => e.type === 'lane.spawned');

describe('the false-ready dead end is structurally impossible (QA finding 1)', () => {
  it('with real execution OFF, the preamble forbids the approval promise', async () => {
    await turn('build me a login page');
    const body = JSON.parse(providerBodies[0] ?? '{}') as { system?: string };
    // The truth is in the actual bytes sent to the provider:
    expect(body.system).toContain('NOT available');
    expect(body.system).toContain('AMRITA_LANES_ALLOW_REAL_EXECUTION=1');
    expect(body.system).not.toContain('session is waiting');
    expect(body.system).not.toContain('Allow button appears');
  });

  it('a blocked build request opens nothing and is parked as ONE Inbox card', async () => {
    await turn('build me a login page');
    await new Promise((r) => setTimeout(r, 50)); // the planner is post-turn
    expect(spawnedLanes()).toHaveLength(0);
    const parked = kernel
      .listInbox({ projectId: ctx.projectId, status: 'pending' })
      .filter((i) => i.text.startsWith('Build request parked'));
    expect(parked).toHaveLength(1);
    expect(parked[0]?.rationale ?? '').toContain('Fix:');
  });

  it('a conversational message parks nothing (no noise)', async () => {
    await turn('what is our current pricing?');
    await new Promise((r) => setTimeout(r, 50));
    expect(
      kernel
        .listInbox({ projectId: ctx.projectId, status: 'pending' })
        .filter((i) => i.text.startsWith('Build request parked')),
    ).toHaveLength(0);
  });

  it('the blocked preamble names exactly one fix and never the promise', () => {
    const blocked = blockedOrchestratorPreamble();
    expect(blocked).toContain(REAL_EXECUTION_FIX);
    expect(blocked).toContain('NEVER tell the operator');
    expect(blocked).not.toContain('waits for the operator to approve');
    // and the managerial identity survives:
    expect(blocked).toContain('managerial brain');
  });
});
