import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel, dispatch, isErrorResponse } from '../src/index.ts';

let kernel: AmritaKernel;
beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => kernel.close());

async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

function ctx(): { projectId: string; conversationId: string } {
  const projectId = kernel.ensureProject({ slug: 'cine-x', name: 'CineX' }).id;
  const conversationId = kernel.createConversation({ projectId, title: 'Cinema sync' }).id;
  return { projectId, conversationId };
}

type Rec = {
  slug: string;
  kind: string;
  title: string;
  tags: string[];
  provenance: { sourceId: string };
};
type Src = { id: string; kind: string; status: string };

describe('cinema-extractor (ADR-0030)', () => {
  it('module:cinema digest → project-context record with module provenance; source flips to connected', async () => {
    const { projectId, conversationId } = ctx();
    // Before any cinema data: source exists but is honestly `planned`.
    const before = await call<Src[]>('harness.sources', { projectId });
    expect(before.find((s) => s.id === 'module:cinema')?.status).toBe('planned');

    await call('memory.put', {
      projectId,
      conversationId,
      scope: 'project',
      content:
        'Cinema project digest — "טיזר" (hash abcd1234)\nshots 2 · storyboard frames 2 · cards 3',
      source: 'module:cinema',
      origin: 'agent',
    });
    await call('decisions.record', {
      projectId,
      conversationId,
      text: '[cinema] Applied plan: Generate keyframes for 2 shots (batch-generate · credit)',
      origin: 'agent',
    });

    const brain = await call<{ records: Rec[] }>('harness.brain', { projectId });
    const digest = brain.records.find((r) => r.tags.includes('digest'));
    expect(digest?.kind).toBe('project-context');
    expect(digest?.title).toContain('Cinema project digest');
    expect(digest?.provenance.sourceId).toBe('module:cinema');

    const decision = brain.records.find((r) => r.kind === 'decision');
    expect(decision?.tags).toContain('cinema');
    expect(decision?.provenance.sourceId).toBe('module:cinema');

    const after = await call<Src[]>('harness.sources', { projectId });
    const src = after.find((s) => s.id === 'module:cinema');
    expect(src?.status).toBe('connected');
    expect(src?.kind).toBe('module');
  });

  it('topology declares the cinema-extractor as an ACTIVE ingest agent', async () => {
    const topo = await call<{ agents: { id: string; role: string; status: string }[] }>(
      'harness.topology',
    );
    const agent = topo.agents.find((a) => a.id === 'cinema-extractor');
    expect(agent?.role).toBe('ingest');
    expect(agent?.status).toBe('active');
  });

  it('non-cinema projects: source stays planned; manual decisions keep manual provenance', async () => {
    const { projectId, conversationId } = ctx();
    await call('decisions.record', { projectId, conversationId, text: 'ship on Friday' });
    const brain = await call<{ records: Rec[] }>('harness.brain', { projectId });
    const d = brain.records.find((r) => r.kind === 'decision');
    expect(d?.provenance.sourceId).toBe('manual');
    expect(d?.tags).not.toContain('cinema');
    const sources = await call<Src[]>('harness.sources', { projectId });
    expect(sources.find((s) => s.id === 'module:cinema')?.status).toBe('planned');
  });
});
