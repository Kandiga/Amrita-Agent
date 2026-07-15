import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaneMandate, MergeReport } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';

/**
 * Reconcile-on-boot (ADR-0048): a lane left `running` by a crash must not lie
 * forever. `activeLanes` is empty at boot, so a non-terminal row with no live handle
 * is definitionally orphaned. Tested across TWO kernels on one DB file — kernel A
 * drives a lane to `running` and stays alive (the "crashed" process); kernel B opens
 * the same DB and its boot sweep reaps the orphan.
 *
 * A `spawned` dry-run lane is deliberately NOT reaped (it is a resting state, not
 * in-flight work) — covered by the last case.
 */

/** Emits progress → the row goes `running` → then blocks until aborted. */
const runningRunner = {
  kind: 'claude-code',
  async run(
    mandate: LaneMandate,
    ctx?: { onProgress?: (note: string, pct?: number) => void; signal?: AbortSignal },
  ): Promise<MergeReport> {
    ctx?.onProgress?.('working', 50);
    await new Promise<void>((resolve) => {
      if (ctx?.signal?.aborted) return resolve();
      ctx?.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return {
      laneId: mandate.laneId,
      summary: 'cancelled',
      artifacts: [],
      decisions: [],
      tasks: [],
      followUps: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      exit: 'cancelled' as const,
    };
  },
};

let dir: string;
let dbPath: string;
let a: AmritaKernel;
let b: AmritaKernel | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-reconcile-'));
  dbPath = join(dir, 'amrita.db');
});
afterEach(() => {
  a?.close();
  b?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcileLanesOnBoot', () => {
  it('reaps a lane left running by a crash — with lane.aborted + origin:system', async () => {
    a = AmritaKernel.open({ dbPath, laneRunner: runningRunner });
    const projectId = a.ensureProject({ slug: 'p', name: 'P' }).id;
    const conversationId = a.createConversation({ projectId }).id;

    const lane = await a.startLane({ conversationId, goal: 'long job', detach: true });
    await new Promise((r) => setTimeout(r, 30)); // let the progress event project
    expect(a.getLane(lane.laneId)?.status).toBe('running');

    // A second kernel on the SAME db (the restarted process) reaps the orphan on boot.
    b = AmritaKernel.open({ dbPath, laneRunner: runningRunner });
    expect(b.getLane(lane.laneId)?.status).toBe('aborted');

    const ev = b
      .listEvents(conversationId, 0)
      .find((e) => e.type === 'lane.aborted' && e.laneId === lane.laneId);
    expect(ev?.origin).toBe('system');
    expect((ev?.payload as { reason?: string }).reason).toMatch(/restart/i);
  });

  it('does NOT reap a spawned dry-run lane (a resting state, not in-flight work)', async () => {
    a = AmritaKernel.open({ dbPath });
    const projectId = a.ensureProject({ slug: 'p', name: 'P' }).id;
    const conversationId = a.createConversation({ projectId }).id;
    const lane = await a.startLane({ conversationId, goal: 'x', dryRun: true });
    expect(a.getLane(lane.laneId)?.status).toBe('spawned');

    b = AmritaKernel.open({ dbPath });
    expect(b.reconcileLanesOnBoot().reconciled).toBe(0);
    expect(b.getLane(lane.laneId)?.status).toBe('spawned'); // untouched
  });
});
