/**
 * The weekly review packet (ADR-0045).
 *
 * From the product brief (voice, file 05):
 *
 *   "פעם בשבוע המתזמן של אמריטה יכין חבילת סקירה, לא יבצע שינויים בשקט. החבילה
 *    תכלול משימות שלא זזו, אבני דרך שהתקרבו, חסמים חדשים, החלטות שמחכות, חריגה
 *    אפשרית מהתוכנית ומה אמריטה ממליצה לעשות."
 *
 *   "אתה עובר על החבילה בשיחה אחת, מאשר, מתקן או דוחה."
 *
 * The whole point is the second clause: **it proposes, it never acts.** A scheduler
 * that quietly changes your plan while you sleep is not a manager, it is a hazard.
 * So this module computes a packet and NOTHING else — the only writes it causes are
 * Inbox items (proposals) and one `message.system` summary. A test asserts the job
 * emits no domain-mutating event at all.
 *
 * Pure: every input is injected, including `now`. Deterministic, therefore testable.
 */
import type {
  MilestoneRow,
  OpenQuestionRow,
  ProjectBriefRow,
  RiskRow,
  TaskRow,
} from '@amrita/store';

const DAY = 86_400_000;

/** A task that has not moved in this long is drifting, not resting. */
export const STALE_DAYS = 10;
/** A milestone this close deserves your attention now, not on the day. */
const MILESTONE_HORIZON_DAYS = 14;

export interface ReviewPacket {
  /** `review:<projectId>:<ISO week>` — the idempotency key. */
  key: string;
  weekOf: string;
  stale: { taskId: string; title: string; daysSinceMoved: number }[];
  approaching: { milestoneId: string; title: string; targetDate: string; daysLeft: number }[];
  overdue: { milestoneId: string; title: string; targetDate: string; daysLate: number }[];
  blockers: { taskId: string; title: string; reason: string }[];
  waitingDecisions: { questionId: string; text: string; ageDays: number }[];
  openRisks: { riskId: string; text: string; severity: string | null }[];
  /** What Amrita RECOMMENDS. Recommendations, not actions. */
  recommendations: string[];
  /** Nothing at all to say — a clean week is a legitimate answer. */
  empty: boolean;
}

export interface ReviewInput {
  projectId: string;
  brief: ProjectBriefRow | null;
  tasks: readonly TaskRow[];
  milestones: readonly MilestoneRow[];
  risks: readonly RiskRow[];
  questions: readonly OpenQuestionRow[];
  /** Injected — the packet must be deterministic. */
  now: Date;
}

/** ISO-8601 week key, e.g. `2026-W29`. The idempotency anchor. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of the current week decides the year (ISO-8601).
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const days = (from: string, to: Date): number =>
  Math.floor((to.getTime() - Date.parse(from)) / DAY);

export function buildReviewPacket(input: ReviewInput): ReviewPacket {
  const today = input.now.toISOString().slice(0, 10);
  const open = input.tasks.filter((t) => t.status === 'now' || t.status === 'later');

  const stale = open
    .map((t) => ({ taskId: t.id, title: t.title, daysSinceMoved: days(t.updatedAt, input.now) }))
    .filter((t) => t.daysSinceMoved >= STALE_DAYS)
    .sort((a, b) => b.daysSinceMoved - a.daysSinceMoved);

  const live = input.milestones.filter(
    (m) => m.status !== 'done' && m.status !== 'dropped' && m.targetDate,
  );
  const approaching = live
    .map((m) => ({
      milestoneId: m.id,
      title: m.title,
      targetDate: m.targetDate as string,
      daysLeft: Math.ceil((Date.parse(m.targetDate as string) - input.now.getTime()) / DAY),
    }))
    .filter((m) => m.daysLeft >= 0 && m.daysLeft <= MILESTONE_HORIZON_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const overdue = live
    .filter((m) => (m.targetDate as string) < today)
    .map((m) => ({
      milestoneId: m.id,
      title: m.title,
      targetDate: m.targetDate as string,
      daysLate: days(m.targetDate as string, input.now),
    }));

  const blockers = open
    .filter((t) => t.blockedReason)
    .map((t) => ({ taskId: t.id, title: t.title, reason: t.blockedReason as string }));

  const waitingDecisions = input.questions
    .filter((q) => q.status === 'open')
    .map((q) => ({ questionId: q.id, text: q.text, ageDays: days(q.createdAt, input.now) }))
    .sort((a, b) => b.ageDays - a.ageDays);

  const openRisks = input.risks
    .filter((r) => r.status === 'open')
    .map((r) => ({ riskId: r.id, text: r.text, severity: r.severity }));

  // Recommendations. Ordered by what would actually change the outcome.
  const recommendations: string[] = [];
  if (overdue.length > 0 && overdue[0]) {
    recommendations.push(
      `"${overdue[0].title}" is ${overdue[0].daysLate} days past its date. Either move the date or cut the scope — leaving it is a decision too.`,
    );
  }
  for (const b of blockers.slice(0, 2)) {
    recommendations.push(`"${b.title}" is waiting on: ${b.reason}. Who can unblock it this week?`);
  }
  if (stale.length > 0 && stale[0]) {
    recommendations.push(
      `${stale.length} task(s) have not moved in over ${STALE_DAYS} days — the oldest is "${stale[0].title}". Drop them or do them.`,
    );
  }
  const oldQuestion = waitingDecisions[0];
  if (oldQuestion && oldQuestion.ageDays >= 7) {
    recommendations.push(
      `"${oldQuestion.text}" has been open ${oldQuestion.ageDays} days. An unanswered question is a decision being made by default.`,
    );
  }
  const highRisk = openRisks.find((r) => r.severity === 'high');
  if (highRisk) {
    recommendations.push(`High risk still open: "${highRisk.text}". Is it mitigated or accepted?`);
  }
  if (!input.brief?.finishLine) {
    recommendations.push('There is still no finish line. "Done" is currently a matter of opinion.');
  }

  const empty =
    stale.length === 0 &&
    approaching.length === 0 &&
    overdue.length === 0 &&
    blockers.length === 0 &&
    waitingDecisions.length === 0 &&
    openRisks.length === 0 &&
    recommendations.length === 0;

  return {
    key: `review:${input.projectId}:${isoWeek(input.now)}`,
    weekOf: isoWeek(input.now),
    stale,
    approaching,
    overdue,
    blockers,
    waitingDecisions,
    openRisks,
    recommendations,
    empty,
  };
}

/** The packet as the one message the operator actually reads. */
export function renderReviewPacket(p: ReviewPacket): string {
  if (p.empty) return `Weekly review (${p.weekOf}): nothing is drifting. A clean week.`;

  const lines: string[] = [`Weekly review (${p.weekOf})`, ''];

  if (p.overdue.length > 0) {
    lines.push('Past their date:');
    for (const m of p.overdue) lines.push(`- ${m.title} — ${m.daysLate}d late (${m.targetDate})`);
  }
  if (p.approaching.length > 0) {
    lines.push('Coming up:');
    for (const m of p.approaching) lines.push(`- ${m.title} — ${m.daysLeft}d (${m.targetDate})`);
  }
  if (p.blockers.length > 0) {
    lines.push('Blocked:');
    for (const b of p.blockers) lines.push(`- ${b.title} — waiting on: ${b.reason}`);
  }
  if (p.stale.length > 0) {
    lines.push('Not moving:');
    for (const t of p.stale.slice(0, 5)) lines.push(`- ${t.title} — ${t.daysSinceMoved}d still`);
  }
  if (p.waitingDecisions.length > 0) {
    lines.push('Waiting on you:');
    for (const q of p.waitingDecisions.slice(0, 5)) lines.push(`- ${q.text} (${q.ageDays}d)`);
  }
  if (p.recommendations.length > 0) {
    lines.push('', 'What I would do:');
    for (const r of p.recommendations) lines.push(`- ${r}`);
  }

  lines.push(
    '',
    'Nothing here has been changed. These are proposals — accept the ones you want in the Inbox.',
  );
  return lines.join('\n');
}
