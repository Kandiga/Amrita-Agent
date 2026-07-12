import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';
import { isOperatorCommand, runOperatorCommand } from '../src/operator.ts';

/**
 * R2: operator commands are interpreted by ONE kernel-level service — every
 * channel renders the same answer. (The Telegram adapter's own tests prove the
 * rendering side; these prove the shared interpreter.)
 */

let kernel: AmritaKernel;
let projectId: string;
let conversationId: string;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:', approvalTimeoutMs: 5_000 });
  projectId = kernel.ensureProject({ slug: 'op', name: 'Op' }).id;
  conversationId = kernel.createConversation({ projectId }).id;
});
afterEach(() => {
  kernel.close();
});

describe('operator-command service', () => {
  it('detects command-shaped text', () => {
    expect(isOperatorCommand('/status')).toBe(true);
    expect(isOperatorCommand('  /help ')).toBe(true);
    expect(isOperatorCommand('hello')).toBe(false);
  });

  it('/status reports brief, tasks, questions, lanes, approvals from real state', async () => {
    kernel.upsertBrief({ projectId, conversationId, goal: 'ship R2' });
    kernel.createTask({ projectId, conversationId, title: 'extract the service' });
    const reply = await runOperatorCommand(kernel, '/status', projectId);
    expect(reply).toContain('goal: ship R2');
    expect(reply).toContain('tasks: 1 open / 1 total');
    expect(reply).toContain('approvals: 0 pending');
  });

  it('/approve resolves a pending approval by unambiguous prefix', async () => {
    const pending = kernel.requestApproval(
      { projectId, conversationId },
      'lane.run-real',
      'test goal',
    );
    const [info] = kernel.listPendingApprovals();
    expect(info).toBeDefined();
    const reply = await runOperatorCommand(
      kernel,
      `/approve ${(info?.approvalId ?? '').slice(0, 8).toLowerCase()}`,
      projectId,
    );
    expect(reply).toContain('approved');
    expect(await pending).toBe('allow');
  });

  it('unknown commands point at /help; /help lists the verbs', async () => {
    expect(await runOperatorCommand(kernel, '/nope', projectId)).toContain('/help');
    const help = await runOperatorCommand(kernel, '/help', projectId);
    for (const verb of ['/status', '/lanes', '/approvals', '/approve', '/stop']) {
      expect(help).toContain(verb);
    }
  });
});
