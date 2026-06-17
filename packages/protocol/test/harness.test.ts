import { describe, expect, it } from 'vitest';
import {
  harnessTopologySchema,
  knowledgeGapSchema,
  knowledgeRecordSchema,
  knowledgeSourceSchema,
  projectBrainSchema,
} from '../src/harness.ts';

describe('organizational brain harness schemas (ADR-0027)', () => {
  it('round-trips a knowledge record with provenance and links', () => {
    const rec = knowledgeRecordSchema.parse({
      slug: 'decision:01ABC',
      kind: 'decision',
      title: 'Use ULIDs everywhere',
      body: '# Use ULIDs\n\nResolves [[open-question:01XYZ]].',
      projectId: 'P1',
      owner: 'nethanel',
      date: '2026-06-17',
      confidence: 'high',
      tags: ['ids', 'architecture'],
      links: ['open-question:01XYZ'],
      status: 'active',
      provenance: { sourceId: 'manual', ref: 'decision:01ABC', channel: 'web' },
    });
    expect(rec.kind).toBe('decision');
    expect(rec.links).toContain('open-question:01XYZ');
  });

  it('rejects unknown record kinds and extra keys (strict)', () => {
    expect(() =>
      knowledgeRecordSchema.parse({
        slug: 's',
        kind: 'rumor', // not a kind
        title: 't',
        body: '',
        projectId: 'P1',
        owner: null,
        date: null,
        confidence: 'low',
        tags: [],
        links: [],
        status: 'active',
        provenance: { sourceId: 'manual' },
      }),
    ).toThrow();
  });

  it('a source is never `connected` by accident — status is an explicit enum', () => {
    const src = knowledgeSourceSchema.parse({
      id: 'email',
      kind: 'email',
      title: 'Email threads',
      status: 'planned',
      detail: 'extraction not built — use manual capture',
      extracts: ['commitments', 'decisions'],
    });
    expect(src.status).toBe('planned');
    expect(() => knowledgeSourceSchema.parse({ ...src, status: 'live' })).toThrow();
  });

  it('validates a gap and the topology spec', () => {
    expect(
      knowledgeGapSchema.parse({
        kind: 'missing-owner',
        severity: 'medium',
        recordSlug: 'commitment:01C',
        detail: 'no owner on this commitment',
      }).kind,
    ).toBe('missing-owner');

    const topo = harnessTopologySchema.parse({
      version: 1,
      agents: [
        {
          id: 'capture',
          role: 'ingest',
          title: 'Manual capture',
          ingests: ['manual'],
          trigger: 'user says "remember this"',
          outputs: ['knowledge record'],
          qualityChecks: ['has provenance'],
          status: 'active',
        },
      ],
    });
    expect(topo.agents[0]?.role).toBe('ingest');
  });

  it('assembles a project brain view', () => {
    const brain = projectBrainSchema.parse({
      projectId: 'P1',
      records: [],
      gaps: [],
      sources: [],
      maintenance: [],
      counts: {
        records: 0,
        gaps: 0,
        sourcesConnected: 0,
        sourcesManual: 1,
        sourcesPlanned: 4,
      },
    });
    expect(brain.counts.sourcesPlanned).toBe(4);
  });
});
