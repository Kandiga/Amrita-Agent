import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaneMandate, MergeReport } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ORCHESTRATION_SETTING } from '../src/context-pack.ts';
import { AmritaKernel, type FetchLike, type FetchResponseLike } from '../src/index.ts';

/**
 * The Planner keystone (ADR-0048): a BUILD/RESEARCH message opens a managed
 * execution session instead of a chat code-dump; a conversational one does not;
 * and the kill-switch turns the whole behavior off.
 */

const fakeChat: FetchLike = async (): Promise<FetchResponseLike> => ({
  ok: true,
  status: 200,
  async json() {
    return {
      content: [{ type: 'text', text: "I'll delegate that to a Claude Code session." }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    };
  },
  async text() {
    return '';
  },
});

const fakeRunner = {
  kind: 'claude-code',
  async run(mandate: LaneMandate): Promise<MergeReport> {
    return {
      laneId: mandate.laneId,
      summary: 'built it',
      artifacts: [],
      decisions: [],
      tasks: [],
      followUps: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      exit: 'done' as const,
    };
  },
};

let kernel: AmritaKernel;
let dir: string;
let ctx: { projectId: string; conversationId: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-planner-'));
  process.env.ANTHROPIC_API_KEY = 'placeholder-value-for-tests';
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    fetchImpl: fakeChat,
    laneRunner: fakeRunner,
    allowRealLaneExecution: true,
    laneAllowedRoots: [dir],
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
  kernel.setProjectRoot({ ...ctx, root: dir });
});

afterEach(() => {
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
  for (const name of ['ANTHROPIC_API_KEY']) delete process.env[name];
});

const spawnedLanes = () =>
  kernel.listEvents(ctx.conversationId, 0).filter((e) => e.type === 'lane.spawned');

const turn = (text: string) =>
  kernel.runChatTurn({ conversationId: ctx.conversationId, text, provider: 'anthropic' });

describe('the Planner delegates build intent to a session (ADR-0048)', () => {
  it('a build request opens a managed session, not a chat code-dump', async () => {
    await turn('build me a login page');
    await new Promise((r) => setTimeout(r, 30));
    const lanes = spawnedLanes();
    expect(lanes).toHaveLength(1);
    expect((lanes[0]?.payload as { kind?: string }).kind).toBe('claude-code');
  });

  it('a conversational message opens no session', async () => {
    await turn('what is our current pricing?');
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnedLanes()).toHaveLength(0);
  });

  it('the kill-switch (orchestration.enabled=false) opens no session', async () => {
    kernel.updateSetting({ ...ctx, key: ORCHESTRATION_SETTING, value: false });
    await turn('build me a login page');
    await new Promise((r) => setTimeout(r, 30));
    expect(spawnedLanes()).toHaveLength(0);
  });
});
