/**
 * The Conclusion Capsule (ADR-0048) — what Amrita shows the operator INSTEAD of
 * code and logs. A DERIVED projection over lane + inbox + approval state, delivered
 * as an RPC result (never an event, never a write path). Six provenance-linked
 * sections: Progress / Decisions / Risks / Conflicts / Validation / Next-Actions.
 *
 * Pure and deterministic (every input injected), like `companion.ts` and
 * `surface.ts` — the doctrine is `execution-route.ts:12` ("DERIVED, never stored;
 * a stored copy would be a lie the moment any input moved"). The output is parsed
 * by `conclusionCapsuleSchema`, so the schema bounds are enforced here.
 */
import {
  type CapsuleItem,
  type ConclusionCapsule,
  type LaneExit,
  type LaneRowStatus,
  conclusionCapsuleSchema,
} from '@amrita/protocol';

export interface CapsuleLane {
  laneId: string;
  kind: string;
  status: LaneRowStatus;
  goal: string;
  exit?: LaneExit;
  summary?: string;
  decisions: string[];
  followUps: string[];
  tasks: string[];
}

export interface CapsuleInboxItem {
  id: string;
  text: string;
  suggestedKind: string | null;
}

export interface CapsuleApproval {
  approvalId: string;
  action: string;
  laneId?: string;
}

export interface ConclusionCapsuleInput {
  conversationId: string;
  lanes: CapsuleLane[];
  /** Pending `origin:'lane'` inbox proposals for this conversation. */
  inbox: CapsuleInboxItem[];
  /** Pending approvals for this conversation. */
  approvals: CapsuleApproval[];
}

type ProvKind = CapsuleItem['provenance'][number]['kind'];
const ACTIVE: readonly LaneRowStatus[] = ['spawned', 'running', 'merging'];
const CAP = 20;

const short = (s: string, n = 300): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const item = (text: string, kind: ProvKind, ref: string, label?: string): CapsuleItem => ({
  text: short(text, 500),
  provenance: [{ kind, ref, ...(label ? { label: short(label, 200) } : {}) }],
});

export function buildConclusionCapsule(input: ConclusionCapsuleInput): ConclusionCapsule {
  const { lanes, inbox, approvals } = input;
  const active = lanes.filter((l) => ACTIVE.includes(l.status));
  const done = lanes.filter((l) => l.status === 'completed');
  const aborted = lanes.filter((l) => l.status === 'aborted');

  const status: ConclusionCapsule['status'] =
    approvals.length > 0
      ? 'blocked'
      : active.length > 0
        ? 'running'
        : done.length > 0
          ? 'done'
          : aborted.length > 0
            ? 'aborted'
            : 'idle';

  const progress = lanes
    .slice(0, CAP)
    .map((l) => item(`[${l.status}] ${l.kind}: ${short(l.goal, 240)}`, 'lane', l.laneId));

  const decisions = [
    ...lanes.flatMap((l) => l.decisions.map((d) => item(d, 'lane', l.laneId))),
    ...inbox.filter((i) => i.suggestedKind === 'decision').map((i) => item(i.text, 'inbox', i.id)),
  ].slice(0, CAP);

  const risks = lanes
    .filter((l) => l.exit === 'partial' || l.exit === 'budget' || l.status === 'aborted')
    .map((l) =>
      item(
        `${l.kind} ended ${l.exit ?? l.status}${l.summary ? `: ${short(l.summary, 200)}` : ''}`,
        'lane',
        l.laneId,
      ),
    )
    .slice(0, CAP);

  const conflicts = approvals
    .filter((a) => a.laneId)
    .map((a) => item(`session is blocked awaiting approval: ${a.action}`, 'approval', a.approvalId))
    .slice(0, CAP);

  const validation = done
    .map((l) =>
      item(
        l.summary
          ? short(l.summary, 400)
          : 'completed — not automatically validated (acceptance is manual)',
        'lane',
        l.laneId,
      ),
    )
    .slice(0, CAP);

  const nextActions = [
    ...approvals.map((a) => item(`approve or deny the ${a.action}`, 'approval', a.approvalId)),
    ...inbox.map((i) => item(`triage: ${short(i.text, 240)}`, 'inbox', i.id)),
  ].slice(0, CAP);

  // Parse through the schema — the boundary is the contract (everything is already
  // bounded above, so this validates rather than truncates).
  return conclusionCapsuleSchema.parse({
    conversationId: input.conversationId,
    status,
    progress,
    decisions,
    risks,
    conflicts,
    validation,
    nextActions,
    rev: lanes.length + inbox.length + approvals.length,
  });
}
