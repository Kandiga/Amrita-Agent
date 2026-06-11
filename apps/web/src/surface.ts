/**
 * The Native Interactive Surface — Stage A (structured artifacts only).
 *
 * Pure builders that derive typed `ArtifactSpec`s from REAL project state
 * (brief, milestones, tasks). No generated code executes, no sample data is
 * invented: an empty project yields an empty surface, and the panel says so.
 * See docs/strategy/native-interactive-surface.md §2.2/§2.3 — this module is
 * the deterministic-renderer stage; sandboxed HTML previews are a later,
 * security-gated stage.
 */

import type { BriefLite, MilestoneLite } from './api.ts';

export interface ArtifactBase {
  /** Stable render key, derived from kind + project. */
  id: string;
  projectId: string;
  /** Provenance: when the underlying typed state last changed, if known. */
  sourceUpdatedAt?: string;
}

export interface BriefSummaryArtifact extends ArtifactBase {
  kind: 'brief-summary';
  goal: string;
  audience?: string;
  successCriteria: string[];
  scope: string[];
  noScope: string[];
}

export interface MilestoneBoardItem {
  id: string;
  title: string;
  status: MilestoneLite['status'];
  targetDate?: string;
  /** Open (not done/dropped) tasks linked to this milestone. */
  openTasks: number;
}

export interface MilestoneBoardArtifact extends ArtifactBase {
  kind: 'milestone-board';
  items: MilestoneBoardItem[];
  unassignedOpenTasks: number;
}

/** A verification receipt for the most recently finished lane (mandate→report). */
export interface LaneReceiptArtifact extends ArtifactBase {
  kind: 'lane-receipt';
  laneId: string;
  laneKind: string;
  exit: string;
  goal?: string;
  summary?: string;
}

export type ArtifactSpec = BriefSummaryArtifact | MilestoneBoardArtifact | LaneReceiptArtifact;

export interface SurfaceInputs {
  projectId: string;
  brief: BriefLite | null;
  milestones: MilestoneLite[];
  tasks: { id: string; status?: string; milestoneId?: string | null }[];
  /** Lane views from the live stream (most-recent first, as lanesList returns). */
  lanes?: {
    id: string;
    kind: string;
    status: string;
    goal?: string;
    exit?: string;
    summary?: string;
  }[];
}

function isOpenTask(t: { status?: string }): boolean {
  return t.status !== 'done' && t.status !== 'dropped';
}

/** Derive the Stage-A surface. Pure and deterministic; [] when there is nothing real to show. */
export function buildSurfaceArtifacts(inputs: SurfaceInputs): ArtifactSpec[] {
  const artifacts: ArtifactSpec[] = [];

  if (inputs.brief) {
    const b = inputs.brief;
    artifacts.push({
      kind: 'brief-summary',
      id: `brief-summary:${inputs.projectId}`,
      projectId: inputs.projectId,
      sourceUpdatedAt: b.updatedAt,
      goal: b.goal,
      ...(b.audience ? { audience: b.audience } : {}),
      successCriteria: b.successCriteria,
      scope: b.scope,
      noScope: b.noScope,
    });
  }

  if (inputs.milestones.length > 0) {
    const openTasks = inputs.tasks.filter(isOpenTask);
    artifacts.push({
      kind: 'milestone-board',
      id: `milestone-board:${inputs.projectId}`,
      projectId: inputs.projectId,
      items: inputs.milestones.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        ...(m.targetDate ? { targetDate: m.targetDate } : {}),
        openTasks: openTasks.filter((t) => t.milestoneId === m.id).length,
      })),
      unassignedOpenTasks: openTasks.filter((t) => !t.milestoneId).length,
    });
  }

  // The most recent FINISHED lane becomes a receipt — proof of delegated work.
  const finished = (inputs.lanes ?? []).find((l) => l.exit);
  if (finished) {
    artifacts.push({
      kind: 'lane-receipt',
      id: `lane-receipt:${finished.id}`,
      projectId: inputs.projectId,
      laneId: finished.id,
      laneKind: finished.kind,
      exit: finished.exit ?? 'unknown',
      ...(finished.goal ? { goal: finished.goal } : {}),
      ...(finished.summary ? { summary: finished.summary } : {}),
    });
  }

  return artifacts;
}
