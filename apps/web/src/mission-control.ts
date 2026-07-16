import type { OperatorApprovalLite } from './api.ts';
import type { LaneView } from './lanes-state.ts';
import { evidenceView } from './task-evidence.ts';

/**
 * HARMONY-1 — Mission Control: ONE derived row per thread of work, joining the
 * task, its live session, its pending approval, and its acceptance evidence.
 * Pure (unit-tested); no new truth — every field comes from existing state and
 * refreshes with it.
 */

export interface MissionTaskLike {
  id: string;
  title: string;
  status: string;
  laneId: string | null;
  blockedReason?: string | null;
  acceptanceJson?: string | null;
  verificationJson?: string | null;
}

export type MissionEvidence = 'none' | 'unverified' | 'pass' | 'fail';

export interface MissionRow {
  taskId: string;
  title: string;
  taskStatus: string;
  evidence: MissionEvidence;
  lane: { laneId: string; kind: string; status: string } | null;
  approval: { approvalId: string; action: string } | null;
  /** Lower = needs the operator sooner. */
  attention: number;
  /** One line: what should happen next on this thread. */
  next: string;
}

const LIVE_LANE = new Set(['spawned', 'running', 'merging']);

export function buildMissionRows(
  tasks: readonly MissionTaskLike[],
  lanesById: Readonly<Record<string, LaneView>>,
  approvals: readonly OperatorApprovalLite[],
): MissionRow[] {
  const rows: MissionRow[] = [];
  for (const t of tasks) {
    if (t.status === 'done' || t.status === 'dropped') continue;
    const ev = evidenceView(t.acceptanceJson ?? null, t.verificationJson ?? null);
    const evidence: MissionEvidence =
      ev.criteria.length === 0
        ? 'none'
        : ev.verified
          ? ev.verified.passed
            ? 'pass'
            : 'fail'
          : 'unverified';
    const laneView = t.laneId ? lanesById[t.laneId] : undefined;
    const lane = laneView
      ? { laneId: laneView.id, kind: laneView.kind, status: laneView.status }
      : null;
    const approvalHit = t.laneId ? approvals.find((a) => a.laneId === t.laneId) : undefined;
    const approval = approvalHit
      ? { approvalId: approvalHit.approvalId, action: approvalHit.action }
      : null;
    const threaded =
      lane !== null || approval !== null || evidence !== 'none' || Boolean(t.blockedReason);
    if (!threaded) continue;

    let attention = 5;
    let next = 'In progress.';
    if (approval) {
      attention = 0;
      next = 'An approval is waiting for you — allow or deny it.';
    } else if (evidence === 'fail') {
      attention = 1;
      next = 'The acceptance checks FAILED — inspect before anything moves.';
    } else if (lane && LIVE_LANE.has(lane.status)) {
      attention = 2;
      next = 'A session is working on this — watch it in its agent tab.';
    } else if (t.blockedReason) {
      attention = 3;
      next = t.blockedReason;
    } else if (evidence === 'unverified') {
      attention = 4;
      next = 'Run Verify to close this on evidence.';
    } else if (evidence === 'pass') {
      attention = 4;
      next = 'Checks passed — review and mark it done.';
    }
    rows.push({
      taskId: t.id,
      title: t.title,
      taskStatus: t.status,
      evidence,
      lane,
      approval,
      attention,
      next,
    });
  }
  return rows.sort((a, b) => a.attention - b.attention || a.title.localeCompare(b.title));
}
