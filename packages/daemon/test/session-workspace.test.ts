import { FakeTmuxController } from '@amrita/lanes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';

let kernel: AmritaKernel;
let tmux: FakeTmuxController;
let projectId: string;
let conversationId: string;

beforeEach(() => {
  tmux = new FakeTmuxController();
  kernel = AmritaKernel.open({ dbPath: ':memory:', tmuxController: tmux });
  projectId = kernel.ensureProject({ slug: 'sessions', name: 'Sessions' }).id;
  conversationId = kernel.createConversation({ projectId }).id;
});

afterEach(() => kernel.close());

async function lane(kind = 'claude-code-tmux'): Promise<string> {
  const result = await kernel.startLane({
    conversationId,
    goal: 'inspect the project',
    kind,
    scope: { paths: ['/tmp'], network: 'none' },
    dryRun: true,
  });
  return result.laneId;
}

describe('project session snapshot (ADR-0050)', () => {
  it('captures a bounded, redacted pane on demand without persisting it', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({ name: sessionName, cwd: '/tmp', agent: 'claude', command: ['claude'] });
    tmux.emit(
      sessionName,
      `${'x'.repeat(70_000)}\nTOKEN=super-secret-value\nsk-1234567890abcdefghijkl\nSelect login method:\n`,
    );
    const eventCount = kernel.listEvents(conversationId, 0).length;

    const snapshot = await kernel.getSessionSnapshot(projectId, laneId);

    expect(snapshot).toMatchObject({ laneId, live: true, state: 'awaiting-auth' });
    expect(snapshot.text.length).toBeLessThanOrEqual(64_000);
    expect(snapshot.text).not.toContain('super-secret-value');
    expect(snapshot.text).not.toContain('sk-1234567890abcdefghijkl');
    expect(snapshot.text).toContain('‹redacted›');
    expect(kernel.listEvents(conversationId, 0)).toHaveLength(eventCount);
  });

  it('never sends operator input into an authentication screen', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({ name: sessionName, cwd: '/tmp', agent: 'claude', command: ['claude'] });
    tmux.emit(sessionName, 'Select login method:\n1. Browser\n2. Token\n');
    const before = await tmux.capturePane(sessionName);

    await expect(kernel.sendSessionInput(projectId, laneId, 'do not type this')).rejects.toThrow(
      /awaiting authentication/i,
    );
    expect(await tmux.capturePane(sessionName)).toBe(before);
  });

  it('never sends operator input into an updater or other blocked startup choice', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({ name: sessionName, cwd: '/tmp', agent: 'claude', command: ['claude'] });
    tmux.emit(
      sessionName,
      '✨ Update available!\n› 1. Update now\n2. Skip\nPress enter to continue',
    );
    const before = await tmux.capturePane(sessionName);

    await expect(kernel.sendSessionInput(projectId, laneId, 'do not type this')).rejects.toThrow(
      /operator choice/i,
    );
    expect(await tmux.capturePane(sessionName)).toBe(before);
  });

  it('fails closed on unknown startup output before the goal marker exists', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({
      name: sessionName,
      cwd: '/tmp',
      agent: 'claude',
      command: ['claude'],
    });
    tmux.emit(sessionName, 'Starting agent… unknown screen');

    await expect(kernel.sendSessionInput(projectId, laneId, 'DO NOT SEND')).rejects.toThrow(
      /has not received its initial goal/i,
    );
  });

  it('sends literal operator input only to the marked live agent process', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({
      name: sessionName,
      cwd: '/tmp',
      agent: 'claude',
      command: ['claude'],
    });
    await tmux.sendGoalOnce(sessionName, 'inspect the project');
    tmux.emit(sessionName, '\n❯ ');

    await expect(kernel.sendSessionInput(projectId, laneId, 'continue safely')).resolves.toEqual({
      laneId,
      sent: true,
    });
    expect(await tmux.capturePane(sessionName)).toContain('continue safely');
  });

  it('refuses dead or mismatched agent panes instead of falling back to a shell', async () => {
    const deadLane = await lane();
    const deadName = `amrita-${deadLane}`;
    await tmux.newSession({
      name: deadName,
      cwd: '/tmp',
      agent: 'claude',
      command: ['claude'],
    });
    tmux.markDead(deadName);
    await expect(kernel.sendSessionInput(projectId, deadLane, 'NO')).resolves.toEqual({
      laneId: deadLane,
      sent: false,
    });

    const mismatchLane = await lane();
    const mismatchName = `amrita-${mismatchLane}`;
    await tmux.newSession({
      name: mismatchName,
      cwd: '/tmp',
      agent: 'codex',
      command: ['codex'],
    });
    await expect(kernel.sendSessionInput(projectId, mismatchLane, 'NO')).resolves.toEqual({
      laneId: mismatchLane,
      sent: false,
    });

    const escapedLane = await lane();
    const escapedName = `amrita-${escapedLane}`;
    await tmux.newSession({
      name: escapedName,
      cwd: '/tmp',
      agent: 'claude',
      command: ['claude'],
    });
    tmux.setCwd(escapedName, '/var/tmp');
    await expect(kernel.sendSessionInput(projectId, escapedLane, 'NO')).resolves.toEqual({
      laneId: escapedLane,
      sent: false,
    });
    await expect(kernel.getSessionSnapshot(projectId, escapedLane)).resolves.toMatchObject({
      live: false,
    });
  });

  it('reports a missing tmux session honestly', async () => {
    const laneId = await lane();
    await expect(kernel.getSessionSnapshot(projectId, laneId)).resolves.toMatchObject({
      laneId,
      live: false,
      state: 'unavailable',
      text: '',
    });
  });

  it('does not reveal a session snapshot through another project id', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({ name: sessionName, cwd: '/tmp', agent: 'claude', command: ['claude'] });
    tmux.emit(sessionName, 'PRIVATE PROJECT OUTPUT');
    const otherProjectId = kernel.ensureProject({ slug: 'other', name: 'Other' }).id;

    await expect(kernel.getSessionSnapshot(otherProjectId, laneId)).rejects.toThrow(
      /no such lane/i,
    );
  });

  it('does not control a session through another project id', async () => {
    const laneId = await lane();
    const sessionName = `amrita-${laneId}`;
    await tmux.newSession({ name: sessionName, cwd: '/tmp', agent: 'claude', command: ['claude'] });
    tmux.emit(sessionName, 'PRIVATE PROJECT OUTPUT');
    const before = await tmux.capturePane(sessionName);
    const otherProjectId = kernel.ensureProject({ slug: 'other-controls', name: 'Other' }).id;

    await expect(kernel.sendSessionInput(otherProjectId, laneId, 'DO NOT SEND')).resolves.toEqual({
      laneId,
      sent: false,
    });
    expect(kernel.finishSession(otherProjectId, laneId)).toEqual({ laneId, finished: false });
    await expect(kernel.cancelSession(otherProjectId, laneId)).resolves.toEqual({
      laneId,
      cancelled: false,
      status: null,
    });
    expect(await tmux.capturePane(sessionName)).toBe(before);
  });

  it('refuses a non-interactive lane instead of inventing a session', async () => {
    const laneId = await lane('claude-code');
    await expect(kernel.getSessionSnapshot(projectId, laneId)).rejects.toThrow(
      /not an interactive session/i,
    );
  });
});
