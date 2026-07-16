import { FakeTmuxController } from '@amrita/lanes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';

/**
 * ONE build session per project (operator rule, 2026-07-17): an upgrade request
 * while a session is open is routed INTO it through the guarded send path —
 * never a sibling session fighting over the same files.
 */

let kernel: AmritaKernel;
let tmux: FakeTmuxController;
let projectId: string;
let conversationId: string;

beforeEach(() => {
  tmux = new FakeTmuxController();
  kernel = AmritaKernel.open({ dbPath: ':memory:', tmuxController: tmux });
  projectId = kernel.ensureProject({ slug: 'single', name: 'Single' }).id;
  conversationId = kernel.createConversation({ projectId }).id;
});
afterEach(() => kernel.close());

/** A live interactive session whose goal is already delivered. */
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

const WORKING = '\nאיזה סוג משחק?\n❯ 1. Arcade\n  2. Puzzle\nEnter to select · Esc to cancel\n';

const spawned = () => kernel.listEvents(conversationId, 0).filter((e) => e.type === 'lane.spawned');

describe('one build session per project', () => {
  it('an upgrade request is TYPED INTO the running session — no second lane', async () => {
    const laneId = await liveSession(WORKING);
    const before = await tmux.capturePane(`amrita-${laneId}`);

    await kernel.runChatTurn({
      conversationId,
      text: 'תבני לי גם לוח תוצאות למשחק',
      provider: 'mock',
    });

    const after = await tmux.capturePane(`amrita-${laneId}`);
    expect(after).toBe(`${before}תבני לי גם לוח תוצאות למשחק\n`); // routed into the session
    expect(spawned()).toHaveLength(1); // still ONE session
    const audit = kernel
      .listEvents(conversationId, 0)
      .filter(
        (e) =>
          e.type === 'lane.progress' &&
          /routed into the running session/.test((e.payload as { note?: string }).note ?? ''),
      );
    expect(audit).toHaveLength(1);
  });

  it('a blocked session (login screen) → honest Inbox note, still no second lane', async () => {
    const laneId = await liveSession('\nSelect login method:\n1. Browser\n2. Token\n');
    const before = await tmux.capturePane(`amrita-${laneId}`);

    await kernel.runChatTurn({
      conversationId,
      text: 'תבני לי דף נחיתה חדש',
      provider: 'mock',
    });

    expect(await tmux.capturePane(`amrita-${laneId}`)).toBe(before); // nothing typed
    expect(spawned()).toHaveLength(1); // and no sibling spawned
    const risk = kernel.listInbox({ projectId }).find((i) => /cannot take input/i.test(i.text));
    expect(risk).toBeTruthy();
  });

  it('setting=false restores multi-session spawning (the old behavior)', async () => {
    await liveSession(WORKING);
    kernel.updateSetting({
      projectId,
      conversationId,
      key: 'orchestration.singleSessionPerProject',
      value: false,
    });
    await kernel.runChatTurn({
      conversationId,
      text: 'תבני לי אתר חדש לגמרי',
      provider: 'mock',
    });
    // The Planner tried the normal path (no ready runtime here → honest no-spawn),
    // but the ROUTING did not swallow it: nothing was typed into the session.
    const pane = await tmux.capturePane(
      `amrita-${(await Promise.resolve(spawned()[0]?.payload as { laneId: string })).laneId}`,
    );
    expect(pane).not.toContain('תבני לי אתר חדש לגמרי');
  });
});
