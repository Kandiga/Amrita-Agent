import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTmuxController, SESSION_GOAL_SENT_PROGRESS } from '@amrita/lanes';
import { afterEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/** ADR-0054 — operator console sessions: the full CLI on the project's real files. */

describe('operator console sessions (ADR-0054)', () => {
  let kernel: AmritaKernel;
  let dir: string | null = null;
  afterEach(() => {
    kernel?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function seeded(opts: Parameters<typeof AmritaKernel.open>[0] = { dbPath: ':memory:' }) {
    kernel = AmritaKernel.open(opts);
    const projectId = kernel.ensureProject({ slug: 'console', name: 'Console' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    return { projectId, conversationId };
  }

  it("workspace:'project' opens the session ON the bound working folder", async () => {
    dir = mkdtempSync(join(tmpdir(), 'amrita-console-'));
    const { projectId, conversationId } = seeded({
      dbPath: ':memory:',
      tmuxController: new FakeTmuxController(),
      laneAllowedRoots: [dir],
    });
    kernel.setProjectRoot({ projectId, conversationId, root: dir });
    const lane = await kernel.startLane({
      conversationId,
      goal: 'Operator console',
      kind: 'claude-code-tmux',
      workspace: 'project',
      dryRun: true,
    });
    const mandate = JSON.parse(kernel.getLane(lane.laneId)?.mandateJson ?? '{}');
    expect(mandate.scope.paths).toEqual([dir]); // the CLI works on real files
  });

  it('refuses honestly when no working folder is bound (never a silent empty jail)', async () => {
    const { conversationId } = seeded({
      dbPath: ':memory:',
      tmuxController: new FakeTmuxController(),
    });
    await expect(
      kernel.startLane({
        conversationId,
        goal: 'Operator console',
        kind: 'claude-code-tmux',
        workspace: 'project',
        dryRun: true,
      }),
    ).rejects.toThrow(/working folder/i);
  });

  it('explicit scope.paths win over the workspace hint', async () => {
    dir = mkdtempSync(join(tmpdir(), 'amrita-console-'));
    const { projectId, conversationId } = seeded({
      dbPath: ':memory:',
      tmuxController: new FakeTmuxController(),
      laneAllowedRoots: [dir],
    });
    kernel.setProjectRoot({ projectId, conversationId, root: dir });
    const explicit = join(dir, 'sub');
    const lane = await kernel.startLane({
      conversationId,
      goal: 'scoped anyway',
      kind: 'claude-code-tmux',
      workspace: 'project',
      scope: { paths: [explicit] },
      dryRun: true,
    });
    const mandate = JSON.parse(kernel.getLane(lane.laneId)?.mandateJson ?? '{}');
    expect(mandate.scope.paths).toEqual([explicit]);
  });

  it('sendGoal:false settles goal delivery on the event log and the runner never types it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'amrita-console-'));
    let sawAlreadySent: boolean | undefined;
    const captureRunner = {
      kind: 'claude-code',
      async run(mandate: { laneId: string }, ctx?: { sessionGoalAlreadySent?: boolean }) {
        sawAlreadySent = ctx?.sessionGoalAlreadySent;
        return {
          laneId: mandate.laneId,
          summary: 'console ran',
          artifacts: [],
          decisions: [],
          tasks: [],
          followUps: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          exit: 'done' as const,
        };
      },
    };
    const { conversationId } = seeded({
      dbPath: ':memory:',
      laneRunner: captureRunner,
      allowRealLaneExecution: true,
      laneAllowedRoots: [dir],
    });
    await kernel.startLane({
      conversationId,
      goal: 'Operator console — label only',
      sendGoal: false,
      detach: true,
      scope: { paths: [join(dir, 'out')] },
    });
    // The ADR-0021 gate still applies; approve so the lane actually runs.
    await new Promise((r) => setTimeout(r, 30));
    const pending = kernel.listPendingApprovals();
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'allow');
    await new Promise((r) => setTimeout(r, 60));

    expect(sawAlreadySent).toBe(true); // the runner is told: never auto-type the goal
    const notes = kernel
      .listEvents(conversationId, 0)
      .filter((e) => e.type === 'lane.progress')
      .map((e) => (e.payload as { note?: string }).note);
    expect(notes).toContain(SESSION_GOAL_SENT_PROGRESS); // settled on the DURABLE log
    expect(notes.some((n) => /operator console/i.test(n ?? ''))).toBe(true); // honest why
  });

  it('rpc bounds workspace to project|isolated at the edge', async () => {
    const { conversationId } = seeded({
      dbPath: ':memory:',
      tmuxController: new FakeTmuxController(),
    });
    const response = await dispatch(kernel, {
      id: 1,
      method: 'lanes.start',
      params: { conversationId, goal: 'x', dryRun: true, workspace: 'anywhere' },
    });
    expect(isErrorResponse(response) && response.error.code).toBe('invalid_params');
  });
});
