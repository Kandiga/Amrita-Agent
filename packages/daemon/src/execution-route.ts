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
 *
 * HEBREW IS FIRST-CLASS. The operator asks in Hebrew ("תבני לי משחק"), and the
 * live event log proved seven real build requests classified `conversational`
 * because these tables were English-only — the Planner never fired and Amrita
 * *said* she was delegating while nothing opened. Hebrew terms are imperative /
 * infinitive verb forms plus strong artifact nouns (משחק, אתר, קוד…). Hebrew
 * phrasing is often verb-less ("אני רוצה משחק סנייק"), so the artifact nouns are
 * included on purpose; the approval gate on every spawned session is the backstop
 * for a false positive, while a false negative silently kills the product promise.
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
  // Hebrew build verbs (imperative/future/infinitive; the ש/ו prefixes are
  // handled by the matcher, not enumerated here)
  'תבני',
  'תבנה',
  'לבנות',
  'בנה לי',
  'צרי',
  'תצרי',
  'תצור',
  'ליצור',
  'תוסיף',
  'תוסיפי',
  'הוסיפי',
  'להוסיף',
  'תשדרג',
  'תשדרגי',
  'לשדרג',
  'שדרוג',
  'תשפר',
  'תשפרי',
  'לשפר',
  'תתקן',
  'תתקני',
  'לתקן',
  'תממש',
  'תממשי',
  'לממש',
  'תטמיע',
  'תטמיעי',
  'להטמיע',
  // Hebrew artifact nouns — in a project chat these are build subjects
  'קוד',
  'באג',
  'סקריפט',
  'משחק',
  'אתר',
  'אפליקציה',
  'דשבורד',
  'לוח בקרה',
  'דף נחיתה',
  'עמוד נחיתה',
  'בוט',
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
  // Hebrew
  'תתקשר',
  'תתקשרי',
  'להתקשר',
  'טלפון',
  'פגישה',
  'חתום',
  'חתימה',
  'משא ומתן',
  'ראיון',
  'חשבונית',
];

/** Work that needs a tool Amrita does not have. */
const CONNECTORS: { match: string[]; what: string; why: string; risk: string; fix: string }[] = [
  {
    match: ['email', 'e-mail', 'send an email', 'inbox', 'mail', 'אימייל', 'מייל', 'דוא"ל'],
    what: 'an email connector',
    why: 'this task means sending or reading mail on your behalf',
    risk: 'it would let Amrita read and send mail as you — an account compromise becomes a mail compromise',
    fix: 'no email connector is built yet (the Brain lists it as planned, not connected)',
  },
  {
    match: [
      'calendar',
      'schedule a meeting',
      'book a slot',
      'invite',
      'יומן',
      'קבע פגישה',
      'קבעי פגישה',
      'לקבוע פגישה',
      'זימון',
    ],
    what: 'a calendar connector',
    why: 'this task means creating or moving events for you',
    risk: 'it would let Amrita change your and other people’s time without asking each time',
    fix: 'no calendar connector is built yet (planned, not connected)',
  },
  {
    match: [
      'post',
      'tweet',
      'publish to',
      'social',
      'פרסם',
      'פרסמי',
      'תפרסם',
      'תפרסמי',
      'לפרסם',
      'פוסט',
      'ציוץ',
    ],
    what: 'a publishing connector',
    why: 'this task means saying something publicly as you',
    risk: 'anything published is public immediately, and cannot be reliably unpublished',
    fix: 'no publishing connector is built yet',
  },
];

/** Research/QA work a session can do without building — the Codex sweet spot. Kept
 *  deliberately narrow so a conversational "can you review my plan?" is NOT read as
 *  a delegation request; the operator's cross-QA/compare flows are UI-initiated. */
const RESEARCH = [
  'research',
  'investigate',
  'benchmark',
  'reproduce',
  'profile',
  'look into',
  'find out',
  // Hebrew
  'תחקור',
  'תחקרי',
  'לחקור',
  'מחקר',
  'תשווה',
  'תשווי',
  'להשוות',
  "בנצ'מרק",
  'שחזר',
  'שחזרי',
  'לשחזר',
  'בדוק למה',
  'בדקי למה',
  'תבדוק למה',
  'תבדקי למה',
];

// Word matching with REAL Unicode boundaries. JS `\b` only understands
// [A-Za-z0-9_], so it can never delimit a Hebrew keyword — the boundary between
// a Hebrew letter and a space does not exist for it (proven live: seven Hebrew
// build requests all classified conversational). Lookarounds over \p{L}\p{N}
// give every script a boundary while keeping the original false-positive
// protection ('pay' still does not fire on 'payment', nor 'sign' on 'design').
// Hebrew terms additionally tolerate the attached one-letter prefixes
// (ו/ש/ה/ל/ב/כ/מ, up to two: "ושתבני", "שתצרי") so conjugated requests match
// the bare verb.
const HEBREW_CHAR = /[֐-׿]/;
const escapeRe = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (term: string): RegExp => {
  const prefixes = HEBREW_CHAR.test(term) ? '(?:[ושהלבכמ]{0,2})' : '';
  return new RegExp(`(?<![\\p{L}\\p{N}_])${prefixes}${escapeRe(term)}(?![\\p{L}\\p{N}_])`, 'iu');
};

const matchesAny = (text: string, list: readonly string[]): boolean =>
  list.some((m) => wordRe(m).test(text));

const connectorFor = (text: string): (typeof CONNECTORS)[number] | undefined =>
  CONNECTORS.find((c) => c.match.some((m) => wordRe(m).test(text)));

const hay = (t: RouteInput['task']): string => `${t.title} ${t.body ?? ''}`.toLowerCase();

export function routeFor(input: RouteInput): RouteVerdict {
  const text = hay(input.task);

  // Already delegated — the lane is the route.
  if (input.task.laneId) {
    return { route: 'delegate', detail: 'Already running in a lane.' };
  }

  // A connector we do not have beats everything else: pretending is the one thing
  // this system must never do.
  const connector = connectorFor(text);
  if (connector) {
    return {
      route: 'needs-connector',
      detail: `Needs ${connector.what}, which Amrita does not have.`,
      missing: {
        what: connector.what,
        why: connector.why,
        risk: connector.risk,
        fix: connector.fix,
      },
    };
  }

  if (matchesAny(text, HUMAN_ONLY)) {
    return {
      route: 'human-only',
      detail: 'A person has to do this — Amrita will not do it quietly on your behalf.',
    };
  }

  if (matchesAny(text, CODEABLE)) {
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

/**
 * What an incoming CHAT MESSAGE is asking for (ADR-0048). This is the chat-side
 * sibling of `routeFor`: `routeFor` grades an existing TASK, this classifies a raw
 * message so the Planner can decide whether to delegate to an execution session.
 *
 * Pure and deterministic, sharing the same keyword tables as `routeFor` (no second
 * source of truth). Deliberately CONSERVATIVE: an unmatched message is
 * `conversational` — Amrita just answers in chat, which is always safe — so a false
 * negative costs nothing while a false `build` would spin up a session. The Planner
 * and the operator's own agent pick are the backstop.
 */
export type IntentKind = 'conversational' | 'build' | 'research' | 'human' | 'needs-connector';

export interface IntentVerdict {
  intent: IntentKind;
  /** Why this intent, in one plain sentence. */
  detail: string;
  /** For `needs-connector`: exactly what is missing and how to get it. */
  missing?: { what: string; why: string; risk: string; fix: string };
}

export function classifyIntent(text: string): IntentVerdict {
  const t = text.toLowerCase();

  // A missing connector beats everything: never pretend a tool exists.
  const connector = connectorFor(t);
  if (connector) {
    return {
      intent: 'needs-connector',
      detail: `Needs ${connector.what}, which Amrita does not have.`,
      missing: {
        what: connector.what,
        why: connector.why,
        risk: connector.risk,
        fix: connector.fix,
      },
    };
  }

  if (matchesAny(t, HUMAN_ONLY)) {
    return {
      intent: 'human',
      detail: 'A person has to do this — Amrita will not do it quietly on your behalf.',
    };
  }

  // Research/QA is checked before build so a "reproduce the bug" reads as research
  // (a Codex sweet spot), while "build the feature" reads as build.
  if (matchesAny(t, RESEARCH)) {
    return { intent: 'research', detail: 'Research Amrita can delegate to a session.' };
  }

  if (matchesAny(t, CODEABLE)) {
    return { intent: 'build', detail: 'Build work Amrita can delegate to an execution session.' };
  }

  return { intent: 'conversational', detail: 'A conversation — nothing to delegate.' };
}

/**
 * The cheap gate (mirrors the Scribe's `looksLikeProjectTruth`): does this turn
 * plausibly want a delegated session? If not, the Planner never spawns a provider.
 */
export function looksLikeBuildIntent(text: string): boolean {
  const { intent } = classifyIntent(text);
  return intent === 'build' || intent === 'research';
}
