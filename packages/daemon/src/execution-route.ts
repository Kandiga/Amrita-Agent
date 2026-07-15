/**
 * What can actually be DONE with a task (ADR-0045).
 *
 * From the product brief (voice, file 06):
 *
 *   "לכל משימה באמריטה יהיה מסלול ברור: 'לבצע עכשיו', 'להעביר לסוכן', 'נדרש חיבור
 *    לכלי חיצוני', 'נדרש אישור' או 'משימה אנושית בלבד'."
 *
 *   "אם חסר חיבור היא לא מתחזה, היא אומרת בדיוק איזה חיבור חסר, למה הוא דרוש ומה
 *    הסיכון באישורו."
 *
 * DERIVED, never stored. A route depends on things that change underneath it — a
 * runtime that stops being installed, a root that gets unbound, a connector that
 * gets authorised. A stored route would be a lie the moment any of those moved;
 * recomputing it costs nothing and can never be stale.
 *
 * Pure: every input is injected. No clock, no store, no probes.
 */
import type { TaskRow } from '@amrita/store';

export type ExecutionRoute =
  /** Nothing is in the way. Just do it. */
  | 'do-now'
  /** Amrita can run this herself, inside a supervised lane. */
  | 'delegate'
  /** It needs a tool she does not have. Say which, why, and what approving it costs. */
  | 'needs-connector'
  /** It is consequential enough that a human must say yes first. */
  | 'needs-approval'
  /** No machine is doing this. A person has to. */
  | 'human-only';

export interface RouteVerdict {
  route: ExecutionRoute;
  /** Why this route, in one plain sentence. Shown on the card. */
  detail: string;
  /** For `needs-connector`: exactly what is missing and how to get it. */
  missing?: { what: string; why: string; risk: string; fix: string };
}

export interface RouteInput {
  task: Pick<TaskRow, 'title' | 'body' | 'status' | 'blockedReason' | 'laneId'>;
  /** Does the project have a working root bound? A lane has nothing to work on without one. */
  hasRoot: boolean;
  /** Is a coding runtime actually installed AND authenticated right now? */
  runtimeReady: boolean;
  /** Is this daemon allowed to really execute, or only dry-run? */
  realExecution: boolean;
}

/**
 * Work that a coding lane can plausibly do. Deliberately conservative: a false
 * `delegate` wastes a lane run and erodes trust, while a false `human-only` costs
 * nothing but a click. When unsure, hand it back to the human.
 */
const CODEABLE = [
  'code',
  'refactor',
  'test',
  'fix',
  'bug',
  'implement',
  'script',
  'build',
  'migrate',
  'rename',
  'document',
  'readme',
  'lint',
  'type',
  'api',
  'endpoint',
  'schema',
];

/** Work no machine should be quietly doing on your behalf. */
const HUMAN_ONLY = [
  'call',
  'phone',
  'meet',
  'meeting',
  'visit',
  'sign',
  'signature',
  'negotiate',
  'interview',
  'hire',
  'pay',
  'invoice',
  'approve',
  'decide',
];

/** Work that needs a tool Amrita does not have. */
const CONNECTORS: { match: string[]; what: string; why: string; risk: string; fix: string }[] = [
  {
    match: ['email', 'e-mail', 'send an email', 'inbox', 'mail'],
    what: 'an email connector',
    why: 'this task means sending or reading mail on your behalf',
    risk: 'it would let Amrita read and send mail as you — an account compromise becomes a mail compromise',
    fix: 'no email connector is built yet (the Brain lists it as planned, not connected)',
  },
  {
    match: ['calendar', 'schedule a meeting', 'book a slot', 'invite'],
    what: 'a calendar connector',
    why: 'this task means creating or moving events for you',
    risk: 'it would let Amrita change your and other people’s time without asking each time',
    fix: 'no calendar connector is built yet (planned, not connected)',
  },
  {
    match: ['post', 'tweet', 'publish to', 'social'],
    what: 'a publishing connector',
    why: 'this task means saying something publicly as you',
    risk: 'anything published is public immediately, and cannot be reliably unpublished',
    fix: 'no publishing connector is built yet',
  },
];

const hay = (t: RouteInput['task']): string => `${t.title} ${t.body ?? ''}`.toLowerCase();

export function routeFor(input: RouteInput): RouteVerdict {
  const text = hay(input.task);

  // Already delegated — the lane is the route.
  if (input.task.laneId) {
    return { route: 'delegate', detail: 'Already running in a lane.' };
  }

  // A connector we do not have beats everything else: pretending is the one thing
  // this system must never do.
  for (const c of CONNECTORS) {
    if (c.match.some((m) => text.includes(m))) {
      return {
        route: 'needs-connector',
        detail: `Needs ${c.what}, which Amrita does not have.`,
        missing: { what: c.what, why: c.why, risk: c.risk, fix: c.fix },
      };
    }
  }

  if (HUMAN_ONLY.some((m) => text.includes(m))) {
    return {
      route: 'human-only',
      detail: 'A person has to do this — Amrita will not do it quietly on your behalf.',
    };
  }

  if (CODEABLE.some((m) => text.includes(m))) {
    if (!input.hasRoot) {
      return {
        route: 'needs-approval',
        detail: 'Amrita could run this, but the project has no working folder bound yet.',
      };
    }
    if (!input.runtimeReady) {
      return {
        route: 'needs-connector',
        detail: 'Amrita could run this, but no coding runtime is ready.',
        missing: {
          what: 'a coding runtime (Claude Code or Codex)',
          why: 'a lane needs a runtime to actually execute',
          risk: 'a runtime can read and write inside the project folder',
          fix: 'install and authenticate a runtime, then check Settings → Runtimes',
        },
      };
    }
    if (!input.realExecution) {
      return {
        route: 'needs-approval',
        detail: 'This daemon can only dry-run. Real execution must be enabled first.',
      };
    }
    return {
      route: 'delegate',
      detail: 'Amrita can run this in a supervised lane, with a budget and a receipt.',
    };
  }

  if (input.task.blockedReason) {
    return { route: 'human-only', detail: `Blocked: ${input.task.blockedReason}` };
  }

  return { route: 'do-now', detail: 'Nothing in the way.' };
}

export const ROUTE_LABEL: Record<ExecutionRoute, string> = {
  'do-now': 'Do now',
  delegate: 'Amrita can do this',
  'needs-connector': 'Needs a connector',
  'needs-approval': 'Needs approval',
  'human-only': 'Human only',
};
