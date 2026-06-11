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

  it('a brief becomes a brief-summary artifact with provenance', () => {
    const artifacts = buildSurfaceArtifacts(base({ brief }));
    expect(artifacts).toHaveLength(1);
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

  it('brief + milestones yield both artifacts, deterministically ordered', () => {
    const artifacts = buildSurfaceArtifacts(
      base({ brief, milestones: [milestone({ id: 'M1', title: 'Alpha' })] }),
    );
    expect(artifacts.map((a) => a.kind)).toEqual(['brief-summary', 'milestone-board']);
    // determinism: same inputs, same output
    expect(
      buildSurfaceArtifacts(base({ brief, milestones: [milestone({ id: 'M1', title: 'Alpha' })] })),
    ).toEqual(artifacts);
  });
});
