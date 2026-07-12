import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel } from '../src/kernel.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/** ADR-0038: session archive + project delete (the one destructive verb). */

let kernel: AmritaKernel;

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => {
  kernel.close();
});

function count(table: string, col: string, id: string): number {
  const row = kernel.store.db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
    .get(id) as { n: number };
  return row.n;
}

describe('conversation.archive (ADR-0038)', () => {
  it('archives a session, keeps its history, and is idempotent', () => {
    const p = kernel.ensureProject({ slug: 'arch', name: 'Arch' });
    const c = kernel.createConversation({ projectId: p.id, title: 'to shelve' });
    kernel.recordUserMessage({ projectId: p.id, conversationId: c.id, text: 'keep me' });

    expect(kernel.archiveConversation(c.id)).toEqual({ ok: true });
    expect(kernel.getConversation(c.id)?.archivedAt).toBeTypeOf('string');
    // history preserved — archive is a shelf, not a shredder
    expect(kernel.store.listMessages(c.id)).toHaveLength(1);
    expect(kernel.listEvents(c.id).length).toBeGreaterThan(0);
    // idempotent: no second archived event
    const before = kernel.listEvents(c.id).filter((e) => e.type === 'conversation.archived');
    kernel.archiveConversation(c.id);
    const after = kernel.listEvents(c.id).filter((e) => e.type === 'conversation.archived');
    expect(after.length).toBe(before.length);
  });

  it('unknown conversation maps to not_found over RPC', async () => {
    const r = await dispatch(kernel, {
      id: 1,
      method: 'conversation.archive',
      params: { conversationId: 'nope' },
    });
    expect(isErrorResponse(r) && r.error.code).toBe('not_found');
  });
});

describe('project.delete (ADR-0038)', () => {
  it('cascades over everything the project owns; other projects survive', () => {
    const doomed = kernel.ensureProject({ slug: 'doomed', name: 'Doomed' });
    const safe = kernel.ensureProject({ slug: 'safe', name: 'Safe' });

    for (const p of [doomed, safe]) {
      const c = kernel.createConversation({ projectId: p.id });
      const ctx = { projectId: p.id, conversationId: c.id };
      kernel.recordUserMessage({ ...ctx, text: `hello ${p.slug}` });
      kernel.createTask({ ...ctx, title: `task ${p.slug}` });
      kernel.recordDecision({ ...ctx, text: `decision ${p.slug}` });
      kernel.putMemoryEntry({ ...ctx, scope: 'project', content: `memory ${p.slug}` });
      kernel.openQuestion({ ...ctx, text: `question ${p.slug}` });
      kernel.openRisk({ ...ctx, text: `risk ${p.slug}` });
      kernel.createMilestone({ ...ctx, title: `milestone ${p.slug}` });
    }

    expect(kernel.deleteProject(doomed.id)).toEqual({ deleted: true });

    // every owned table is empty for the doomed project…
    for (const [table, col] of [
      ['projects', 'id'],
      ['conversations', 'project_id'],
      ['events', 'project_id'],
      ['tasks', 'project_id'],
      ['decisions', 'project_id'],
      ['open_questions', 'project_id'],
      ['risks', 'project_id'],
      ['milestones', 'project_id'],
      ['memory_entries', 'project_id'],
      ['lanes', 'project_id'],
      ['channel_pairings', 'project_id'],
    ] as const) {
      expect(count(table, col, doomed.id), `${table} not emptied`).toBe(0);
    }
    // …and the safe project keeps every row
    expect(count('projects', 'id', safe.id)).toBe(1);
    expect(count('conversations', 'project_id', safe.id)).toBe(1);
    expect(count('events', 'project_id', safe.id)).toBeGreaterThan(0);
    expect(count('tasks', 'project_id', safe.id)).toBe(1);
    expect(count('memory_entries', 'project_id', safe.id)).toBe(1);
    expect(kernel.store.listMessages(kernel.listConversations(safe.id)[0]?.id ?? '')).toHaveLength(
      1,
    );
  });

  it('refuses the reserved system project as conflict, unknown ids as not_found', async () => {
    const sys = kernel.ensureProject({ slug: 'system', name: 'Global Amrita' });
    const r1 = await dispatch(kernel, {
      id: 1,
      method: 'project.delete',
      params: { projectId: sys.id },
    });
    expect(isErrorResponse(r1) && r1.error.code).toBe('conflict');
    expect(kernel.getProject({ id: sys.id })).toBeDefined();

    const r2 = await dispatch(kernel, {
      id: 2,
      method: 'project.delete',
      params: { projectId: 'ghost' },
    });
    expect(isErrorResponse(r2) && r2.error.code).toBe('not_found');
  });
});
