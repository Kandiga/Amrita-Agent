/**
 * Companion next-best-actions — a PURE, rule-based derivation over typed state.
 *
 * Deliberately not an LLM planner (see docs/strategy/project-companion-roadmap.md,
 * Stage 0): every suggestion must be a truth derivable from the doctor report,
 * tasks, decisions, and lanes the UI already holds. When nothing is wrong and
 * nothing is pending, the honest answer is an empty list — the UI says so
 * instead of inventing busywork.
 */

import type { LaneView } from './lanes-state.ts';

export interface CompanionInputs {
  doctor: {
    sections: { title: string; checks: { label: string; status: 'ok' | 'warn' | 'fail' }[] }[];
  } | null;
  tasks: { id: string; title: string; status?: string }[];
  decisions: { id: string }[];
  lanes: LaneView[];
  /** Whether a conversation is open (writes need one). */
  conversationId: string;
}

export type CompanionUrgency = 'blocker' | 'attention' | 'suggestion';

export interface CompanionAction {
  id: string;
  urgency: CompanionUrgency;
  label: string;
  detail: string;
}

const URGENCY_ORDER: Record<CompanionUrgency, number> = {
  blocker: 0,
  attention: 1,
  suggestion: 2,
};

/** Derive the next-best actions, most urgent first. Pure and deterministic. */
export function nextActions(inputs: CompanionInputs): CompanionAction[] {
  const actions: CompanionAction[] = [];

  // 1. Runtime failures block everything else.
  const failing = (inputs.doctor?.sections ?? [])
    .flatMap((s) => s.checks)
    .filter((c) => c.status === 'fail');
  for (const check of failing) {
    actions.push({
      id: `fix:${check.label}`,
      urgency: 'blocker',
      label: 'Fix runtime setup',
      detail: `${check.label} is failing — see the Runtime panel's "How to fix".`,
    });
  }

  // 2. A running lane deserves eyes; a freshly finished one deserves review.
  const active = inputs.lanes.find(
    (l) => l.status === 'spawned' || l.status === 'running' || l.status === 'merging',
  );
  if (active) {
    actions.push({
      id: `lane-watch:${active.id}`,
      urgency: 'attention',
      label: 'A lane is working',
      detail: active.goal ? `Watching: "${active.goal}"` : 'Watch its progress in the Lanes panel.',
    });
  } else {
    const finished = inputs.lanes.find((l) => l.exit);
    if (finished) {
      actions.push({
        id: `lane-review:${finished.id}`,
        urgency: 'attention',
        label: 'Review the lane report',
        detail: `Lane ${finished.id.slice(0, 8)} finished with exit "${finished.exit}"${
          finished.summary ? ` — ${finished.summary}` : ''
        }.`,
      });
    }
  }

  // 3. Project knowledge: only suggest writes when a conversation can carry them.
  if (inputs.conversationId) {
    const open = inputs.tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
    if (inputs.tasks.length === 0) {
      actions.push({
        id: 'task-first',
        urgency: 'suggestion',
        label: 'Capture the first task',
        detail: 'This project has no tasks yet — add the next concrete step.',
      });
    } else if (open.length > 0 && open[0]) {
      actions.push({
        id: `task-work:${open[0].id}`,
        urgency: 'suggestion',
        label: 'Work the top task',
        detail: `"${open[0].title}" is open${open.length > 1 ? ` (+${open.length - 1} more)` : ''}.`,
      });
    }
    if (inputs.decisions.length === 0) {
      actions.push({
        id: 'decision-first',
        urgency: 'suggestion',
        label: 'Record a decision',
        detail: 'No decisions logged yet — write down the first real choice you made.',
      });
    }
  }

  return actions.sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]);
}
