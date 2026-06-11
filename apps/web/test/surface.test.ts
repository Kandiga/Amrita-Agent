import { describe, expect, it } from 'vitest';
import type { BriefLite, MilestoneLite } from '../src/api.ts';
import { type SurfaceInputs, buildSurfaceArtifacts } from '../src/surface.ts';

const brief: BriefLite = {
  projectId: 'P1',
  goal: 'ship the CRM',
  audience: 'small agencies',
  successCriteria: ['login works'],
  scope: ['web'],
  noScope: ['mobile'],
  updatedAt: '2026-06-11T10:00:00.000Z',
};

function milestone(over: Partial<MilestoneLite> & { id: string; title: string }): MilestoneLite {
  return { description: null, status: 'planned', targetDate: null, ...over };
}

function base(over: Partial<SurfaceInputs> = {}): SurfaceInputs {
  return { projectId: 'P1', brief: null, milestones: [], tasks: [], ...over };
}

describe('surface builders (Stage A — deterministic, no sample data)', () => {
  it('an empty project yields an empty surface — honesty over demo content', () => {
    expect(buildSurfaceArtifacts(base())).toEqual([]);
  });

  it('a brief becomes a brief-summary artifact with provenance (plus its preview)', () => {
    const artifacts = buildSurfaceArtifacts(base({ brief }));
    expect(artifacts.map((a) => a.kind)).toEqual(['brief-summary', 'html-preview']);
    expect(artifacts[0]).toMatchObject({
      kind: 'brief-summary',
      id: 'brief-summary:P1',
      goal: 'ship the CRM',
      audience: 'small agencies',
      successCriteria: ['login works'],
      sourceUpdatedAt: '2026-06-11T10:00:00.000Z',
    });
  });

  it('milestones become a board with open-task counts; done/dropped tasks excluded', () => {
    const artifacts = buildSurfaceArtifacts(
      base({
        milestones: [
          milestone({ id: 'M1', title: 'Alpha', status: 'active', targetDate: '2026-07-01' }),
          milestone({ id: 'M2', title: 'Beta' }),
        ],
        tasks: [
          { id: 'T1', status: 'now', milestoneId: 'M1' },
          { id: 'T2', status: 'later', milestoneId: 'M1' },
          { id: 'T3', status: 'done', milestoneId: 'M1' }, // closed — not counted
          { id: 'T4', status: 'now', milestoneId: null }, // unassigned
        ],
      }),
    );
    expect(artifacts).toHaveLength(1);
    const board = artifacts[0];
    expect(board).toMatchObject({ kind: 'milestone-board', unassignedOpenTasks: 1 });
    if (board?.kind === 'milestone-board') {
      expect(board.items).toEqual([
        { id: 'M1', title: 'Alpha', status: 'active', targetDate: '2026-07-01', openTasks: 2 },
        { id: 'M2', title: 'Beta', status: 'planned', openTasks: 0 },
      ]);
    }
  });

  it('the most recent FINISHED lane becomes a receipt; active lanes do not', () => {
    const none = buildSurfaceArtifacts(
      base({ lanes: [{ id: 'L1', kind: 'claude-code', status: 'running', goal: 'wip' }] }),
    );
    expect(none).toEqual([]); // running lane: nothing to receipt yet

    const artifacts = buildSurfaceArtifacts(
      base({
        lanes: [
          { id: 'L2', kind: 'claude-code', status: 'running', goal: 'wip' }, // newest, unfinished
          {
            id: 'L1',
            kind: 'claude-code',
            status: 'completed',
            goal: 'tidy repo',
            exit: 'done',
            summary: 'all tidy',
          },
        ],
      }),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: 'lane-receipt',
      laneId: 'L1',
      exit: 'done',
      goal: 'tidy repo',
      summary: 'all tidy',
    });
  });

  it('html-preview: derived from brief+brand, proposed until the exact hash is approved', () => {
    const brand = {
      projectId: 'P1',
      name: 'Nimbus',
      audience: null,
      tone: 'premium, calm',
      styleNotes: [],
      palette: ['#0EA5E9 cyan accents'],
      typography: null,
      doNotUse: [],
      updatedAt: '2026-06-11T10:00:00.000Z',
    };
    const artifacts = buildSurfaceArtifacts(base({ brief, brand }));
    const preview = artifacts.find((a) => a.kind === 'html-preview');
    expect(preview?.kind).toBe('html-preview');
    if (preview?.kind !== 'html-preview') return;
    // product-real: brand name, tone, palette accent, and brief content are in
    expect(preview.title).toBe('Nimbus');
    expect(preview.html).toContain('Nimbus');
    expect(preview.html).toContain('premium, calm');
    expect(preview.html).toContain('#0EA5E9');
    expect(preview.html).toContain('login works');
    // never auto-approved
    expect(preview.status).toBe('proposed');

    // approving the EXACT hash flips it to approved…
    const approved = buildSurfaceArtifacts(
      base({
        brief,
        brand,
        previewApprovals: [
          {
            previewId: preview.id,
            contentHash: preview.contentHash,
            approvedAt: '2026-06-11T11:00:00.000Z',
          },
        ],
      }),
    ).find((a) => a.kind === 'html-preview');
    expect(approved?.kind === 'html-preview' && approved.status).toBe('approved');

    // …and any state drift demotes honestly back to proposed
    const drifted = buildSurfaceArtifacts(
      base({
        brief: { ...brief, goal: 'ship the CRM v2' },
        brand,
        previewApprovals: [
          {
            previewId: preview.id,
            contentHash: preview.contentHash,
            approvedAt: '2026-06-11T11:00:00.000Z',
          },
        ],
      }),
    ).find((a) => a.kind === 'html-preview');
    expect(drifted?.kind === 'html-preview' && drifted.status).toBe('proposed');
  });

  it('html-preview escapes project text and says so when brand is unset', () => {
    const hostile = buildSurfaceArtifacts(
      base({ brief: { ...brief, goal: '<script>alert(1)</script>' } }),
    ).find((a) => a.kind === 'html-preview');
    if (hostile?.kind !== 'html-preview') throw new Error('expected preview');
    expect(hostile.html).not.toContain('<script>');
    expect(hostile.html).toContain('&lt;script&gt;');
    // neutral defaults are labeled, never an invented identity
    expect(hostile.html).toContain('neutral preview — no brand memory set');
  });

  it('brief + milestones yield both artifacts, deterministically ordered', () => {
    const artifacts = buildSurfaceArtifacts(
      base({ brief, milestones: [milestone({ id: 'M1', title: 'Alpha' })] }),
    );
    expect(artifacts.map((a) => a.kind)).toEqual([
      'brief-summary',
      'milestone-board',
      'html-preview',
    ]);
    // determinism: same inputs, same output
    expect(
      buildSurfaceArtifacts(base({ brief, milestones: [milestone({ id: 'M1', title: 'Alpha' })] })),
    ).toEqual(artifacts);
  });
});
