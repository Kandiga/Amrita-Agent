import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTmuxController, type LaneRunContext, type LaneRunner } from '@amrita/lanes';
import { type LaneMandate, type MergeReport, type UnsealedEvent, newId } from '@amrita/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function report(mandate: LaneMandate): MergeReport {
  return {
    laneId: mandate.laneId,
    summary: 'restart evidence captured',
    artifacts: [],
    decisions: [],
    tasks: [],
    followUps: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    exit: 'done',
  };
}

describe('durable tmux restart recovery (ADR-0050)', () => {
  it('passes durable goal-delivery evidence to resumed sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'amrita-session-restart-'));
    roots.push(root);
    const dbPath = join(root, 'amrita.db');
    const tmux = new FakeTmuxController();

    const first = AmritaKernel.open({ dbPath, tmuxController: tmux });
    const projectId = first.ensureProject({ slug: 'restart', name: 'Restart' }).id;
    const conversationId = first.createConversation({ projectId }).id;
    const createLane = async (note: string): Promise<string> => {
      const started = await first.startLane({
        conversationId,
        goal: `goal for ${note}`,
        kind: 'claude-code-tmux',
        dryRun: true,
      });
      first.store.appendEvent({
        id: newId(),
        ts: new Date().toISOString(),
        projectId,
        conversationId,
        laneId: started.laneId,
        origin: 'lane',
        type: 'lane.progress',
        payload: { note },
      } as UnsealedEvent);
      await tmux.newSession({
        name: `amrita-${started.laneId}`,
        cwd: root,
        agent: 'claude',
        command: ['claude'],
      });
      return started.laneId;
    };

    const sentLaneId = await createLane('sent the goal to the session');
    const authLaneId = await createLane(
      'awaiting operator authentication; no session input was sent',
    );
    first.close();

    const seen = new Map<string, boolean | undefined>();
    const runner: LaneRunner = {
      kind: 'claude-code-tmux',
      async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
        seen.set(mandate.laneId, ctx?.sessionGoalAlreadySent);
        return report(mandate);
      },
    };
    const second = AmritaKernel.open({
      dbPath,
      tmuxController: tmux,
      extraLaneRunners: [runner],
    });
    try {
      await second.resumeTmuxSessions();
      expect(seen.get(sentLaneId)).toBe(true);
      expect(seen.get(authLaneId)).toBe(false);
    } finally {
      second.close();
    }
  });
});
