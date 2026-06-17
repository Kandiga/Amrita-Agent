import type { ProjectBrain } from '@amrita/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProjectBrain } from '../src/harness.ts';
import { AmritaKernel, baseKnowledgeSources, dispatch, isErrorResponse } from '../src/index.ts';

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
  const projectId = kernel.ensureProject({ slug: 'brain', name: 'Brain' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

describe('organizational brain harness (ADR-0027)', () => {
  it('topology and sources are honest: capture active, email/calendar planned', async () => {
    const topo = await call<{ agents: { id: string; status: string; role: string }[] }>(
      'harness.topology',
    );
    const capture = topo.agents.find((a) => a.id === 'capture');
    expect(capture?.status).toBe('active');
    const mailbox = topo.agents.find((a) => a.id === 'mailbox-extractor');
    expect(mailbox?.status).toBe('planned'); // never claims a connector that doesn't exist

    const sources = await call<{ id: string; status: string }[]>('harness.sources');
    expect(sources.find((s) => s.id === 'manual')?.status).toBe('manual');
    expect(sources.find((s) => s.id === 'email')?.status).toBe('planned');
    expect(sources.find((s) => s.id === 'chat')?.status).toBe('planned');
  });

  it('empty project → empty brain, honest source counts (no fake records)', async () => {
    const c = ctx();
    const brain = await call<ProjectBrain>('harness.brain', { projectId: c.projectId });
    expect(brain.records).toEqual([]);
    expect(brain.gaps).toEqual([]);
    expect(brain.counts.records).toBe(0);
    expect(brain.counts.sourcesPlanned).toBeGreaterThan(0);
    expect(brain.counts.sourcesConnected).toBe(0);
  });

  it('derives a decision record linked to the question it resolved', async () => {
    const c = ctx();
    const { questionId } = kernel.openQuestion({ ...c, text: 'Which id scheme?' });
    const { decisionId } = kernel.recordDecision({ ...c, text: 'Use ULIDs #ids' });
    kernel.resolveQuestion({ ...c, questionId, resolvedByDecisionId: decisionId });

    const brain = await call<ProjectBrain>('harness.brain', { projectId: c.projectId });
    const decision = brain.records.find((r) => r.slug === `decision:${decisionId}`);
    expect(decision?.kind).toBe('decision');
    expect(decision?.provenance.sourceId).toBe('manual');
    expect(decision?.links).toContain(`open-question:${questionId}`);
    // resolved question carries the reverse link and resolved status
    const q = brain.records.find((r) => r.slug === `open-question:${questionId}`);
    expect(q?.status).toBe('resolved');
    expect(q?.links).toContain(`decision:${decisionId}`);
  });

  it('manual capture (capture-agent) creates a commitment record with provenance + owner/date', async () => {
    const c = ctx();
    const cap = await call<{ entryId: string; kind: string }>('harness.capture', {
      ...c,
      kind: 'commitment',
      title: 'Ship the installer',
      owner: 'nethanel',
      date: '2026-07-01',
      tags: ['release'],
    });
    expect(cap.kind).toBe('commitment');

    const brain = await call<ProjectBrain>('harness.brain', { projectId: c.projectId });
    const rec = brain.records.find((r) => r.kind === 'commitment');
    expect(rec?.owner).toBe('nethanel');
    expect(rec?.date).toBe('2026-07-01');
    expect(rec?.provenance.sourceId).toBe('manual');
    expect(rec?.tags).toContain('release');
    // a fully-specified commitment raises no missing-owner/missing-date gap
    const ownerDateGaps = brain.gaps.filter(
      (g) =>
        g.recordSlug === rec?.slug && (g.kind === 'missing-owner' || g.kind === 'missing-date'),
    );
    expect(ownerDateGaps).toEqual([]);
  });

  it('flags an open question and an ownerless commitment as gaps', async () => {
    const c = ctx();
    kernel.openQuestion({ ...c, text: 'Open thing?' });
    await call('harness.capture', { ...c, kind: 'commitment', title: 'Do the thing' });
    const brain = await call<ProjectBrain>('harness.brain', { projectId: c.projectId });
    expect(brain.gaps.some((g) => g.kind === 'unresolved-question')).toBe(true);
    expect(brain.gaps.some((g) => g.kind === 'missing-owner')).toBe(true);
  });

  it('buildProjectBrain marks stale active records and surfaces contradictions (pure)', () => {
    const brain = buildProjectBrain({
      projectId: 'P1',
      now: '2026-06-17T00:00:00.000Z',
      brief: null,
      decisions: [
        {
          id: 'D1',
          projectId: 'P1',
          conversationId: null,
          sourceMessageId: null,
          supersedesId: null,
          text: 'An old decision',
          createdAt: '2025-01-01T00:00:00.000Z', // >90 days ago
        },
      ],
      questions: [],
      risks: [],
      milestones: [],
      tasks: [],
      memory: [
        {
          id: 'M1',
          scope: 'project',
          projectId: 'P1',
          content: 'contradiction: the deadline is both July and August',
          charCount: 10,
          source: 'manual:brain',
          sourceMessageId: null,
          createdAt: '2026-06-16T00:00:00.000Z',
          updatedAt: '2026-06-16T00:00:00.000Z',
        },
      ],
      timeline: [],
      sources: baseKnowledgeSources(),
      staleDays: 90,
    });
    const decision = brain.records.find((r) => r.slug === 'decision:D1');
    expect(decision?.status).toBe('stale');
    expect(brain.gaps.some((g) => g.kind === 'stale')).toBe(true);
    expect(brain.gaps.some((g) => g.kind === 'contradiction')).toBe(true);
  });
});
