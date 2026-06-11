import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';

let kernel: AmritaKernel;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => {
  kernel.close();
});

function ctx(): { projectId: string; conversationId: string } {
  const projectId = kernel.ensureProject({ slug: 'demo', name: 'Demo' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

describe('AmritaKernel', () => {
  it('opens a temp-file DB and runs migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amritad-'));
    const k = AmritaKernel.open({ dbPath: join(dir, 'amrita.db') });
    const h = k.health();
    expect(h.ok).toBe(true);
    expect(h.name).toBe('amritad');
    expect(h.schemaVersion).toBe(4); // 0000..0004 applied
    expect(h.counts.projects).toBe(0);
    k.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('ensureProject is create-or-get by slug', () => {
    const a = kernel.ensureProject({ slug: 'demo', name: 'Demo' });
    const b = kernel.ensureProject({ slug: 'demo', name: 'Demo (again)' });
    expect(b.id).toBe(a.id); // same row
    expect(kernel.listProjects()).toHaveLength(1);
    expect(kernel.getProject({ slug: 'demo' })?.id).toBe(a.id);
    expect(kernel.getProject({ id: a.id })?.slug).toBe('demo');
  });

  it('recordUserMessage produces an event through the Store API', () => {
    const { conversationId, projectId } = ctx();
    const { messageId, event } = kernel.recordUserMessage({
      projectId,
      conversationId,
      text: 'hello amrita',
      channel: 'cli',
    });
    expect(event.type).toBe('message.user');
    expect(event.channel).toBe('cli');
    const events = kernel.listEvents(conversationId);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(event.id);
    expect(messageId).toBe(event.id);
  });

  it('delegates tasks / decisions / memory / settings', () => {
    const { conversationId, projectId } = ctx();
    const { taskId } = kernel.createTask({ projectId, conversationId, title: 'fix bug' });
    kernel.completeTask({ projectId, conversationId, taskId });
    expect(kernel.listTasks({ status: 'done' })).toHaveLength(1);

    const { decisionId } = kernel.recordDecision({ projectId, conversationId, text: 'use SQLite' });
    expect(kernel.listDecisions({ projectId })[0]?.id).toBe(decisionId);

    kernel.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'RTL bidi note',
    });
    expect(kernel.searchMemory('bidi', {})).toHaveLength(1); // FTS via Store API

    kernel.updateSetting({ projectId, conversationId, key: 'theme', value: 'dark' });
    expect(kernel.getSetting('theme')).toBe('dark');
    expect(kernel.getSetting('missing')).toBeNull();
  });

  it('accounts: connect, bind env-NAME, config status (no secret value)', () => {
    const { conversationId, projectId } = ctx();
    const { accountId } = kernel.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    expect(kernel.getProviderConfigStatus(accountId)).toBe('missing_secret_ref');
    kernel.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
    expect(kernel.getProviderConfigStatus(accountId)).toBe('healthy');
    const acc = kernel.listAccounts().find((a) => a.id === accountId);
    expect(acc?.secretRef).toBe('ANTHROPIC_API_KEY'); // an env NAME, not a value
  });
});
