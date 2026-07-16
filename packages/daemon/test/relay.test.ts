import { FakeTmuxController } from '@amrita/lanes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyRelay } from '../src/execution-route.ts';
import { AmritaKernel } from '../src/kernel.ts';

/**
 * ADR-0051 — the chat relay seam. The classifier is deliberately conservative
 * (a false positive types into a live agent session); the kernel seam runs
 * BEFORE the reply and only ever writes through the guarded sendSessionInput.
 */

describe('classifyRelay — conservative grammar (ADR-0051)', () => {
  it('matches imperative option picks, Hebrew and English', () => {
    expect(classifyRelay('תבחרי אופציה 2')).toEqual({ kind: 'option', value: '2' });
    expect(classifyRelay('בחר 3')).toEqual({ kind: 'option', value: '3' });
    expect(classifyRelay('תבחר באפשרות 1 בבקשה')).toEqual({ kind: 'option', value: '1' });
    expect(classifyRelay('select option 4')).toEqual({ kind: 'option', value: '4' });
    expect(classifyRelay('pick 2')).toEqual({ kind: 'option', value: '2' });
  });

  it('matches a bare option message and a session-targeted pick', () => {
    expect(classifyRelay('אופציה 2')).toEqual({ kind: 'option', value: '2' });
    expect(classifyRelay('option 5.')).toEqual({ kind: 'option', value: '5' });
    expect(classifyRelay('תבחרי אופציה 1 בסשן 2')).toEqual({
      kind: 'option',
      value: '1',
      session: 2,
    });
  });

  it('matches explicit free-text relay only with the session word', () => {
    expect(classifyRelay('שלחי לסשן: כן, תמשיך לבנות')).toEqual({
      kind: 'text',
      value: 'כן, תמשיך לבנות',
    });
    expect(classifyRelay('send to the session: continue with dark mode')).toEqual({
      kind: 'text',
      value: 'continue with dark mode',
    });
  });

  it('refuses past tense, questions, session-only clauses, and plain chat', () => {
    expect(classifyRelay('בחרתי באופציה 2 אתמול')).toBeNull();
    expect(classifyRelay('מה אופציה 2?')).toBeNull();
    expect(classifyRelay('בחר בסשן 2')).toBeNull(); // a target without an option is NOT "type 2"
    expect(classifyRelay('שלחי לי סיכום של הפגישה')).toBeNull(); // no session word after the verb
    expect(classifyRelay('מה שלומך היום?')).toBeNull();
    expect(classifyRelay('האם כדאי לבחור נושא כהה לאתר?')).toBeNull();
  });
});

describe('the relay seam types into the session BEFORE the reply (ADR-0051)', () => {
  let kernel: AmritaKernel;
  let tmux: FakeTmuxController;
  let projectId: string;
  let conversationId: string;

  beforeEach(() => {
    tmux = new FakeTmuxController();
    kernel = AmritaKernel.open({ dbPath: ':memory:', tmuxController: tmux });
    projectId = kernel.ensureProject({ slug: 'relay', name: 'Relay' }).id;
    conversationId = kernel.createConversation({ projectId }).id;
  });

  afterEach(() => kernel.close());

  /** A live interactive session whose goal is already delivered (the menu is up). */
  async function liveSession(pane: string): Promise<string> {
    const { laneId } = await kernel.startLane({
      conversationId,
      goal: 'build the game',
      kind: 'claude-code-tmux',
      scope: { paths: ['/tmp'], network: 'none' },
      dryRun: true,
    });
    const name = `amrita-${laneId}`;
    await tmux.newSession({ name, cwd: '/tmp', agent: 'claude', command: ['claude'] });
    await tmux.sendGoalOnce(name, 'build the game');
    tmux.emit(name, pane);
    return laneId;
  }

  const MENU = '\nאיזה סוג משחק?\n❯ 1. Arcade\n  2. Puzzle\nEnter to select · Esc to cancel\n';

  it('"תבחרי אופציה 2" reaches the pane and leaves a value-free audit note', async () => {
    const laneId = await liveSession(MENU);
    const before = await tmux.capturePane(`amrita-${laneId}`);

    await kernel.runChatTurn({ conversationId, text: 'תבחרי אופציה 2', provider: 'mock' });

    const after = await tmux.capturePane(`amrita-${laneId}`);
    expect(after).toBe(`${before}2\n`); // the option digit + Enter, nothing else
    const audit = kernel
      .listEvents(conversationId, 0)
      .filter(
        (e) =>
          e.type === 'lane.progress' &&
          (e.payload as { note?: string }).note === 'operator input relayed from chat',
      );
    expect(audit).toHaveLength(1);
  });

  it('never types into a login screen — the turn still succeeds with an honest note', async () => {
    const laneId = await liveSession('\nSelect login method:\n1. Browser\n2. Token\n');
    const before = await tmux.capturePane(`amrita-${laneId}`);

    const turn = await kernel.runChatTurn({
      conversationId,
      text: 'תבחרי אופציה 2',
      provider: 'mock',
    });

    expect(turn.text).toBeTruthy(); // the reply happened
    expect(await tmux.capturePane(`amrita-${laneId}`)).toBe(before); // nothing typed
  });

  it('with two active sessions and no target, nothing is sent', async () => {
    const a = await liveSession(MENU);
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for a stable order
    const b = await liveSession(MENU);
    const beforeA = await tmux.capturePane(`amrita-${a}`);
    const beforeB = await tmux.capturePane(`amrita-${b}`);

    await kernel.runChatTurn({ conversationId, text: 'בחר 1', provider: 'mock' });

    expect(await tmux.capturePane(`amrita-${a}`)).toBe(beforeA);
    expect(await tmux.capturePane(`amrita-${b}`)).toBe(beforeB);
  });

  it('a named target ("בסשן 2") reaches the OLDER of two sessions (newest first)', async () => {
    const older = await liveSession(MENU);
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt for a stable order
    const newer = await liveSession(MENU);
    const beforeNewer = await tmux.capturePane(`amrita-${newer}`);

    await kernel.runChatTurn({ conversationId, text: 'תבחרי אופציה 1 בסשן 2', provider: 'mock' });

    expect(await tmux.capturePane(`amrita-${older}`)).toContain('1\n');
    expect(await tmux.capturePane(`amrita-${newer}`)).toBe(beforeNewer);
  });

  it('the kill-switch disables the relay entirely', async () => {
    const laneId = await liveSession(MENU);
    kernel.updateSetting({ projectId, conversationId, key: 'orchestration.enabled', value: false });
    const before = await tmux.capturePane(`amrita-${laneId}`);

    await kernel.runChatTurn({ conversationId, text: 'תבחרי אופציה 2', provider: 'mock' });

    expect(await tmux.capturePane(`amrita-${laneId}`)).toBe(before);
  });

  it('plain conversation never touches the session', async () => {
    const laneId = await liveSession(MENU);
    const before = await tmux.capturePane(`amrita-${laneId}`);

    await kernel.runChatTurn({ conversationId, text: 'מה שלומך היום?', provider: 'mock' });

    expect(await tmux.capturePane(`amrita-${laneId}`)).toBe(before);
  });
});
