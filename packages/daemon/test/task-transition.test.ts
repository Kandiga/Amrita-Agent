import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTmuxController } from '@amrita/lanes';
import { afterEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';
import { resolveTaskTransition } from '../src/task-transition.ts';

/** ADR-0048 §8.4 — confidence-gated task transition; QA lane correlation (§9). */

describe('resolveTaskTransition (pure) — lane proposes, human disposes', () => {
  const base = {
    taskStatus: 'now' as const,
    criteria: 'none' as const,
    autoEnabled: false,
    goal: 'ship it',
  };

  it('never touches a task the human already closed', () => {
    expect(resolveTaskTransition({ ...base, taskStatus: 'done', exit: 'done' })).toBeNull();
    expect(resolveTaskTransition({ ...base, taskStatus: 'dropped', exit: 'done' })).toBeNull();
  });

  it('an operator cancel produces no action (the human chose)', () => {
    expect(resolveTaskTransition({ ...base, exit: 'cancelled' })).toBeNull();
  });

  it('done + auto ON + no criteria → auto REVIEW annotation, never silent done', () => {
    const d = resolveTaskTransition({ ...base, exit: 'done', autoEnabled: true });
    expect(d?.mode).toBe('auto');
    if (d?.mode === 'auto') expect(d.blockedReason).toMatch(/review/i);
  });

  it('done + auto OFF → a PROPOSAL, never an auto change', () => {
    const d = resolveTaskTransition({ ...base, exit: 'done', autoEnabled: false });
    expect(d?.mode).toBe('propose');
  });

  it('done + UNVERIFIED criteria → propose review even with auto ON', () => {
    const d = resolveTaskTransition({
      ...base,
      exit: 'done',
      autoEnabled: true,
      criteria: 'unverified',
    });
    expect(d?.mode).toBe('propose');
    if (d?.mode === 'propose') expect(d.reason).toMatch(/unverified/i);
  });

  it('done + VERIFIED-PASS criteria + auto ON → auto review WITH evidence (ADR-0055)', () => {
    const d = resolveTaskTransition({
      ...base,
      exit: 'done',
      autoEnabled: true,
      criteria: 'verified-pass',
    });
    expect(d?.mode).toBe('auto');
    if (d?.mode === 'auto') expect(d.reason).toMatch(/evidence|passed/i);
  });

  it('done + VERIFIED-FAIL criteria → a blocked proposal even with auto ON (evidence beats prose)', () => {
    const d = resolveTaskTransition({
      ...base,
      exit: 'done',
      autoEnabled: true,
      criteria: 'verified-fail',
    });
    expect(d?.mode).toBe('propose');
    if (d?.mode === 'propose') {
      expect(d.suggestedStatus).toBe('blocked');
      expect(d.reason).toMatch(/failed/i);
    }
  });

  it('partial/budget/aborted → a blocked proposal, never auto', () => {
    for (const exit of ['partial', 'budget', 'aborted'] as const) {
      const d = resolveTaskTransition({ ...base, exit, autoEnabled: true });
      expect(d?.mode).toBe('propose');
      if (d?.mode === 'propose') expect(d.suggestedStatus).toBe('blocked');
    }
  });
});

describe('kernel wiring — transition on a delegated lane completion', () => {
  let kernel: AmritaKernel;
  let root: string | null = null;
  afterEach(() => {
    kernel?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  function fakeRunner(exit: 'done' | 'partial') {
    return {
      kind: 'claude-code',
      async run(mandate: { laneId: string }) {
        return {
          laneId: mandate.laneId,
          summary: `ran: ${exit}`,
          artifacts: [],
          decisions: [],
          tasks: [],
          followUps: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          exit,
        };
      },
    };
  }

  async function delegated(exit: 'done' | 'partial', autoEnabled: boolean) {
    root = mkdtempSync(join(tmpdir(), 'amrita-tt-'));
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      laneRunner: fakeRunner(exit),
      allowRealLaneExecution: true,
      laneAllowedRoots: [root],
      codingRuntimeProber: async () => ({ kind: 'ok', stdout: '2.1.0', stderr: '' }),
    });
    const projectId = kernel.ensureProject({ slug: 'tt', name: 'TT' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    kernel.setProjectRoot({ projectId, conversationId, root });
    if (autoEnabled) {
      kernel.updateSetting({
        projectId,
        conversationId,
        key: 'orchestration.autoTaskTransition',
        value: true,
      });
    }
    const { taskId } = kernel.createTask({ projectId, conversationId, title: 'Build the widget' });
    await kernel.delegateTask({ projectId, conversationId, taskId });
    // A real delegated lane pauses at the ADR-0021 gate (nothing runs until a human
    // says yes). By the time we approve, the task→lane link is already on the event
    // log, so the merge's transition finds the linked task deterministically.
    await new Promise((r) => setTimeout(r, 30));
    const pending = kernel.listPendingApprovals();
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'allow');
    await new Promise((r) => setTimeout(r, 60));
    return { projectId, taskId };
  }

  it('done + auto ON → the linked task is annotated for review (not marked done)', async () => {
    const { projectId, taskId } = await delegated('done', true);
    const task = kernel.listTasks({ projectId }).find((t) => t.id === taskId);
    expect(task?.status).not.toBe('done'); // NEVER a silent done
    expect(task?.blockedReason).toMatch(/review/i);
  });

  it('done + auto OFF → an Inbox proposal, task untouched', async () => {
    const { projectId, taskId } = await delegated('done', false);
    const task = kernel.listTasks({ projectId }).find((t) => t.id === taskId);
    expect(task?.blockedReason ?? null).toBeNull();
    const proposals = kernel
      .listInbox({ projectId })
      .filter((i) => i.origin === 'lane' && /review whether/i.test(i.text));
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });

  it('partial → a blocked proposal even with auto ON', async () => {
    const { projectId } = await delegated('partial', true);
    const proposals = kernel
      .listInbox({ projectId })
      .filter((i) => i.origin === 'lane' && /without finishing/i.test(i.text));
    expect(proposals.length).toBeGreaterThanOrEqual(1);
  });
});

describe('QA lane correlation (ADR-0049 §9)', () => {
  let kernel: AmritaKernel;
  afterEach(() => kernel?.close());

  it('a verifiesLaneId lane inherits the build lane workspace + qa role/group', async () => {
    const tmux = new FakeTmuxController();
    kernel = AmritaKernel.open({ dbPath: ':memory:', tmuxController: tmux });
    const projectId = kernel.ensureProject({ slug: 'qa', name: 'QA' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;

    const build = await kernel.startLane({
      conversationId,
      goal: 'build the feature',
      kind: 'claude-code-tmux',
      scope: { paths: ['/tmp/build-out'] },
      dryRun: true,
    });
    const qa = await kernel.startLane({
      conversationId,
      goal: 'verify the feature',
      kind: 'codex-tmux',
      verifiesLaneId: build.laneId,
      dryRun: true,
    });

    const qaRow = kernel.getLane(qa.laneId);
    expect(qaRow?.role).toBe('qa');
    expect(qaRow?.verifiesLaneId).toBe(build.laneId);
    expect(qaRow?.groupId).toBe(build.laneId); // inherits/derives the build's group
    const mandate = JSON.parse(qaRow?.mandateJson ?? '{}');
    expect(mandate.scope.paths).toEqual(['/tmp/build-out']); // its cwd IS the build output
  });

  it('a foreign-project verification target is refused', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', tmuxController: new FakeTmuxController() });
    const p1 = kernel.ensureProject({ slug: 'a', name: 'A' }).id;
    const c1 = kernel.createConversation({ projectId: p1 }).id;
    const p2 = kernel.ensureProject({ slug: 'b', name: 'B' }).id;
    const c2 = kernel.createConversation({ projectId: p2 }).id;
    const build = await kernel.startLane({
      conversationId: c1,
      goal: 'build',
      kind: 'claude-code-tmux',
      scope: { paths: ['/tmp/x'] },
      dryRun: true,
    });
    await expect(
      kernel.startLane({
        conversationId: c2,
        goal: 'verify across projects',
        kind: 'codex-tmux',
        verifiesLaneId: build.laneId,
        dryRun: true,
      }),
    ).rejects.toThrow(/same project/i);
  });
});
