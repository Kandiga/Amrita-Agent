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
  const projectId = kernel.ensureProject({ slug: 'comp', name: 'Companion' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

describe('project companion over RPC (ADR-0018)', () => {
  it('companion.get aggregates brief/questions/risks/milestones, honestly empty at first', async () => {
    const c = ctx();
    const empty = await call<{ brief: unknown; questions: unknown[] }>('projects.companion.get', {
      projectId: c.projectId,
    });
    expect(empty).toEqual({
      brief: null,
      brand: null,
      questions: [],
      risks: [],
      milestones: [],
      previewApprovals: [],
    });

    await call('projects.brief.update', {
      ...c,
      goal: 'ship the CRM',
      successCriteria: ['login works'],
      scope: ['web'],
      noScope: ['mobile'],
    });
    await call('projects.questions.open', { ...c, text: 'which auth?' });
    await call('projects.risks.open', { ...c, text: 'data loss', severity: 'high' });
    await call('projects.milestones.create', { ...c, title: 'Alpha', targetDate: '2026-07-01' });

    const full = await call<{
      brief: { goal: string; successCriteria: string[] } | null;
      questions: { text: string; status: string }[];
      risks: { severity: string | null }[];
      milestones: { title: string; status: string }[];
    }>('projects.companion.get', { projectId: c.projectId });
    expect(full.brief?.goal).toBe('ship the CRM');
    expect(full.brief?.successCriteria).toEqual(['login works']);
    expect(full.questions[0]).toMatchObject({ text: 'which auth?', status: 'open' });
    expect(full.risks[0]?.severity).toBe('high');
    expect(full.milestones[0]).toMatchObject({ title: 'Alpha', status: 'planned' });
  });

  it('question resolve/drop enforce evidence over RPC (structured errors, no stack)', async () => {
    const c = ctx();
    const { questionId } = await call<{ questionId: string }>('projects.questions.open', {
      ...c,
      text: 'hosting?',
    });
    // neither a note nor a decision link → the protocol refine rejects it
    const bad = await dispatch(kernel, {
      id: 2,
      method: 'projects.questions.resolve',
      params: { ...c, questionId },
    });
    expect(isErrorResponse(bad)).toBe(true);
    if (isErrorResponse(bad)) {
      expect(bad.error.code).toBe('invalid_params'); // a deep ZodError is an input problem
      expect(bad.error.message).not.toMatch(/\bat \//);
    }

    const { decisionId } = await call<{ decisionId: string }>('decisions.record', {
      ...c,
      text: 'use a VPS',
    });
    await call('projects.questions.resolve', {
      ...c,
      questionId,
      resolvedByDecisionId: decisionId,
    });
    const after = await call<{ questions: { status: string; resolvedByDecisionId: string }[] }>(
      'projects.companion.get',
      { projectId: c.projectId },
    );
    expect(after.questions[0]).toMatchObject({
      status: 'resolved',
      resolvedByDecisionId: decisionId,
    });
  });

  it('milestones complete; tasks can be created linked to one', async () => {
    const c = ctx();
    const { milestoneId } = await call<{ milestoneId: string }>('projects.milestones.create', {
      ...c,
      title: 'Beta',
    });
    await call('tasks.create', { ...c, title: 'write docs', milestoneId });
    const tasks = await call<{ milestoneId: string | null }[]>('tasks.list', {
      projectId: c.projectId,
    });
    expect(tasks[0]?.milestoneId).toBe(milestoneId);

    await call('projects.milestones.update', { ...c, milestoneId, status: 'active' });
    await call('projects.milestones.complete', { ...c, milestoneId });
    const m = await call<{ milestones: { status: string }[] }>('projects.companion.get', {
      projectId: c.projectId,
    });
    expect(m.milestones[0]?.status).toBe('done');
    // a bad milestone link is a safe structured error
    const bad = await dispatch(kernel, {
      id: 3,
      method: 'tasks.create',
      params: { ...c, title: 'x', milestoneId: 'NOSUCHMILESTONE9999999999' },
    });
    expect(isErrorResponse(bad)).toBe(true);
  });

  it('brand + preview approvals round-trip through RPC, project-scoped (ADR-0020)', async () => {
    const c = ctx();
    await call('projects.brand.update', {
      ...c,
      name: 'Nimbus',
      tone: 'premium, calm',
      palette: ['#0EA5E9 cyan'],
      doNotUse: ['no neon gradients'],
    });
    const previewId = `html-preview:${c.projectId}`;
    await call('projects.previews.approve', { ...c, previewId, contentHash: 'h1' });

    const full = await call<{
      brand: { name: string; tone: string; palette: string[] } | null;
      previewApprovals: { previewId: string; contentHash: string }[];
    }>('projects.companion.get', { projectId: c.projectId });
    expect(full.brand).toMatchObject({ name: 'Nimbus', tone: 'premium, calm' });
    expect(full.previewApprovals[0]).toMatchObject({ previewId, contentHash: 'h1' });

    // empty brand write → safe invalid_params (deep refine), nothing stored
    const other = kernel.ensureProject({ slug: 'comp-other', name: 'Other' }).id;
    const bad = await dispatch(kernel, {
      id: 9,
      method: 'projects.brand.update',
      params: { projectId: other, conversationId: c.conversationId },
    });
    expect(isErrorResponse(bad) && bad.error.code).toBe('invalid_params');
    // cross-project isolation: the other project sees nothing
    const otherState = await call<{ brand: unknown; previewApprovals: unknown[] }>(
      'projects.companion.get',
      { projectId: other },
    );
    expect(otherState.brand).toBeNull();
    expect(otherState.previewApprovals).toEqual([]);
  });

  it('timeline.list returns the derived project activity, newest first and bounded', async () => {
    const c = ctx();
    await call('projects.brief.update', {
      ...c,
      goal: 'g',
      successCriteria: [],
      scope: [],
      noScope: [],
    });
    await call('projects.questions.open', { ...c, text: 'q1' });
    await call('projects.milestones.create', { ...c, title: 'M' });

    const timeline = await call<{ type: string }[]>('projects.timeline.list', {
      projectId: c.projectId,
    });
    expect(timeline[0]?.type).toBe('milestone.created');
    expect(timeline.map((e) => e.type)).toContain('brief.updated');
    const bounded = await call<unknown[]>('projects.timeline.list', {
      projectId: c.projectId,
      limit: 2,
    });
    expect(bounded).toHaveLength(2);
    // no secret-shaped content anywhere on the companion surface
    expect(JSON.stringify(timeline)).not.toMatch(/sk-|password/i);
  });
});
