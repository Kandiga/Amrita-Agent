import { describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/index.ts';

/** HARMONY-2 — channel push: approvals reach paired chats; the digest is honest. */

describe('channel notifiers', () => {
  it('requestApproval pushes to registered notifiers with the approvalId', async () => {
    const kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const projectId = kernel.ensureProject({ slug: 'n', name: 'N' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    const pushed: { projectId: string; text: string; approvalId?: string }[] = [];
    kernel.registerChannelNotifier('fake', (pid, text, opts) => {
      pushed.push({
        projectId: pid,
        text,
        ...(opts?.approvalId ? { approvalId: opts.approvalId } : {}),
      });
    });
    const pendingDecision = kernel.requestApproval(
      { projectId, conversationId },
      'lane.run-real',
      'build the thing',
    );
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.text).toMatch(/Approval waiting: lane.run-real/);
    expect(pushed[0]?.approvalId).toBeTruthy();
    kernel.resolveApproval(pushed[0]?.approvalId ?? '', 'deny');
    await expect(pendingDecision).resolves.toBe('deny');
    kernel.close();
  });

  it('a throwing notifier never breaks the approval path', async () => {
    const kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const projectId = kernel.ensureProject({ slug: 't', name: 'T' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    kernel.registerChannelNotifier('boom', () => {
      throw new Error('push exploded');
    });
    const d = kernel.requestApproval({ projectId, conversationId }, 'x');
    const pending = kernel.listPendingApprovals();
    expect(pending).toHaveLength(1);
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'allow');
    await expect(d).resolves.toBe('allow');
    kernel.close();
  });
});

describe('daily digest', () => {
  it('is null when everything is quiet (silent day sends nothing)', () => {
    const kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const projectId = kernel.ensureProject({ slug: 'q', name: 'Q' }).id;
    expect(kernel.buildDailyDigest(projectId)).toBeNull();
    kernel.close();
  });

  it('reports approvals waiting, waiting tasks and failing checks', () => {
    const kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const projectId = kernel.ensureProject({ slug: 'd', name: 'D' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    void kernel.requestApproval({ projectId, conversationId }, 'task.verify');
    const { taskId } = kernel.createTask({ projectId, conversationId, title: 'Ship' });
    kernel.updateTask({ projectId, conversationId, taskId, blockedReason: 'review me' });
    const digest = kernel.buildDailyDigest(projectId);
    expect(digest).toMatch(/approval\(s\) waiting: task.verify/);
    expect(digest).toMatch(/waiting on you: Ship/);
    const pending = kernel.listPendingApprovals();
    kernel.resolveApproval(pending[0]?.approvalId ?? '', 'deny');
    kernel.close();
  });
});
