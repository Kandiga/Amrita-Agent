import type { LaneExit, TaskStatus } from '@amrita/protocol';

/**
 * Confidence-gated task transition on a delegated lane's completion
 * (ADR-0048 §8.4, owner decision 3). PURE and deterministic — mirrors the
 * Scribe's auto-open-questions boundary: the safe/reversible class may auto-
 * advance, everything else becomes an Inbox proposal (lane proposes, human
 * disposes, ADR-0045).
 *
 * The load-bearing honesty rule: a lane exiting `done` means the SESSION
 * finished, NOT that the work is correct. So auto NEVER sets the task to `done`
 * (that would be a claim from prose). The strongest auto action is a REVIEW
 * annotation — a `blockedReason` marking the task as "finished, needs review"
 * (the ADR-0044 Waiting column; the `done` enum is not widened). Auto is
 * additionally flag-gated (`orchestration.autoTaskTransition`, default off) and
 * only fires with no unverifiable acceptance criteria.
 */

export type TaskTransition =
  | { mode: 'auto'; blockedReason: string; reason: string }
  | { mode: 'propose'; text: string; suggestedStatus: 'done' | 'blocked'; reason: string };

export interface TransitionInput {
  /** The linked task's current status. Terminal (`done`/`dropped`) → no action. */
  taskStatus: TaskStatus;
  /** The completing lane's exit. */
  exit: LaneExit;
  /** Whether the mandate carried deliverables/acceptance criteria we cannot verify. */
  hasAcceptanceCriteria: boolean;
  /** The `orchestration.autoTaskTransition` flag (default off = always propose). */
  autoEnabled: boolean;
  /** The goal, for a human-readable proposal. */
  goal: string;
}

const REVIEW_NOTE = 'A session finished this — review the result, then mark it done.';

export function resolveTaskTransition(input: TransitionInput): TaskTransition | null {
  // Never touch a task the human already closed, and never re-open a dropped one.
  if (input.taskStatus === 'done' || input.taskStatus === 'dropped') return null;
  // An operator cancel is the human choosing to stop — not a result to act on.
  if (input.exit === 'cancelled') return null;

  if (input.exit === 'done') {
    if (input.autoEnabled && !input.hasAcceptanceCriteria) {
      // Safe/reversible class: annotate for review, attributed. NEVER silent-done.
      return {
        mode: 'auto',
        blockedReason: REVIEW_NOTE,
        reason: "lane exited 'done' with no acceptance criteria — advanced to review by Amrita",
      };
    }
    // Criteria we cannot machine-verify, or auto disabled → propose the review.
    return {
      mode: 'propose',
      text: `A session finished "${clip(input.goal)}" — review whether it meets the bar, then close the task.`,
      suggestedStatus: 'done',
      reason: input.hasAcceptanceCriteria
        ? 'exit done but acceptance criteria are unverified'
        : 'auto task transition disabled',
    };
  }

  // partial / budget / aborted → the work did not finish; propose the next step.
  return {
    mode: 'propose',
    text: `A session for "${clip(input.goal)}" ended '${input.exit}' without finishing — decide whether to continue, split, or drop it.`,
    suggestedStatus: 'blocked',
    reason: `lane exited '${input.exit}'`,
  };
}

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
