import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTmuxController, TmuxSessionLaneRunner } from '@amrita/lanes';
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
    // Hermetic tmux: the Planner opens a *-tmux session, so override the node runner
    // with a fake-tmux one (a real spawn is gated behind approval, which we deny,
    // but this keeps the test from ever touching the host).
    extraLaneRunners: [
      new TmuxSessionLaneRunner({
        agent: 'claude',
        tmux: new FakeTmuxController(),
        allowedRoots: [dir],
        captureIntervalMs: 5,
        goalDelayMs: 0,
      }),
    ],
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
    // A streamed, interactive tmux session (ADR-0049) — visible in the Claude tab.
    expect((lanes[0]?.payload as { kind?: string }).kind).toBe('claude-code-tmux');
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

  it('the Conclusion Capsule reflects the session and reading it writes NOTHING (ADR-0048)', async () => {
    await turn('build me a login page');
    await new Promise((r) => setTimeout(r, 30));
    const before = kernel.listEvents(ctx.conversationId, 0).length;
    const capsule = kernel.getConclusionCapsule(ctx.conversationId);
    expect(capsule.progress.length).toBeGreaterThan(0); // the session shows up
    expect(['blocked', 'running']).toContain(capsule.status);
    // the capsule is DERIVED — reading it appends no event, it is never a write path.
    expect(kernel.listEvents(ctx.conversationId, 0).length).toBe(before);
  });
});
