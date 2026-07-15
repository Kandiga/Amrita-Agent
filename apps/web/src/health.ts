/**
 * The status strip — pure (ADR-0045).
 *
 * "בחלק העליון תהיה שורת מצב דקה: מה היעד הבא? כמה זמן נשאר? מה בריאות הפרויקט?
 *  ומה החסם המרכזי? לא עשרים מספרים, אלא שלוש או ארבע אינדיקציות שבאמת משנות
 *  החלטה."
 *
 * Four indicators. Not twenty numbers. Each one is here because it changes what
 * you would do next; anything that does not is noise and belongs somewhere else.
 *
 * Clock-free: `today` is passed in, so this is deterministic and testable.
 */
import type { MilestoneRowWire, RiskRowWire, TaskRowWire } from '@amrita/protocol';

export type ProjectHealth = 'on-track' | 'at-risk' | 'blocked' | 'not-started';

export interface StatusStrip {
  health: ProjectHealth;
  /** The next thing that is actually due. */
  nextMilestone: { title: string; targetDate: string | null; daysLeft: number | null } | null;
  /** The single most important thing in the way. Null when nothing is. */
  topBlocker: { text: string; kind: 'blocked-task' | 'open-risk' | 'overdue' } | null;
  counts: { open: number; blocked: number; overdue: number };
}

const DAY = 86_400_000;

/** Whole days from `today` to `date`. Negative = in the past. */
export function daysBetween(today: string, date: string): number {
  return Math.round((Date.parse(date) - Date.parse(today)) / DAY);
}

export interface StatusStripInput {
  activated: boolean;
  tasks: readonly TaskRowWire[];
  milestones: readonly MilestoneRowWire[];
  risks: readonly RiskRowWire[];
  /** Today as YYYY-MM-DD. */
  today: string;
}

export function buildStatusStrip(input: StatusStripInput): StatusStrip {
  const open = input.tasks.filter((t) => t.status === 'now' || t.status === 'later');
  const blocked = open.filter((t) => t.blockedReason);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < input.today);

  // The next milestone that is still live, soonest first. A milestone with no date
  // cannot be "next" — it is a wish, not a deadline.
  const nextMilestone =
    input.milestones
      .filter((m) => m.status !== 'done' && m.status !== 'dropped' && m.targetDate)
      .sort((a, b) => (a.targetDate ?? '').localeCompare(b.targetDate ?? ''))
      .map((m) => ({
        title: m.title,
        targetDate: m.targetDate,
        daysLeft: m.targetDate ? daysBetween(input.today, m.targetDate) : null,
      }))[0] ?? null;

  // The ONE thing most in the way. Order matters: something overdue beats something
  // merely blocked, and a high risk beats a low one.
  const highRisk = input.risks
    .filter((r) => r.status === 'open')
    .sort((a, b) => (a.severity === 'high' ? -1 : b.severity === 'high' ? 1 : 0))[0];

  let topBlocker: StatusStrip['topBlocker'] = null;
  if (overdue.length > 0 && overdue[0]) {
    topBlocker = { text: `${overdue[0].title} is overdue`, kind: 'overdue' };
  } else if (blocked.length > 0 && blocked[0]) {
    topBlocker = {
      text: blocked[0].blockedReason ?? blocked[0].title,
      kind: 'blocked-task',
    };
  } else if (highRisk?.severity === 'high') {
    topBlocker = { text: highRisk.text, kind: 'open-risk' };
  }

  let health: ProjectHealth;
  if (!input.activated) {
    health = 'not-started';
  } else if (overdue.length > 0 || (nextMilestone?.daysLeft ?? 99) < 0) {
    health = 'blocked';
  } else if (blocked.length > 0 || highRisk?.severity === 'high') {
    health = 'at-risk';
  } else {
    health = 'on-track';
  }

  return {
    health,
    nextMilestone,
    topBlocker,
    counts: { open: open.length, blocked: blocked.length, overdue: overdue.length },
  };
}

export const HEALTH_LABEL: Record<ProjectHealth, string> = {
  'not-started': 'Not started',
  'on-track': 'On track',
  'at-risk': 'At risk',
  blocked: 'Blocked',
};
