/**
 * The retrospective, and what crosses out of the project (ADR-0045).
 *
 * From the product brief (voice, file 06):
 *
 *   "בסוף שלב או פרויקט תופעל רטרוספקטיבה. אמריטה תשאל מה אבד, מה נכשל, אילו הנחות
 *    היו שגויות ואיזה ידע שווה לשמור."
 *
 *   "הלקחים לא יזלגו אוטומטית לכל הפרויקטים. **אתה תאשר** מה הופך לידע ארגוני, והוא
 *    יישמר עם המקור וההקשר. בפרויקט הבא היא תוכל לומר: 'בפרויקט דומה התאריך נשבר
 *    בגלל אישור ספקים, ולכן כדאי לפתוח את המסלול הזה מוקדם'."
 *
 * The second paragraph is the design. Cross-project learning is the most dangerous
 * feature in a system like this: one project's hard-won lesson is another project's
 * confidently-wrong assumption. So:
 *
 *   - the retro packet is COMPUTED from what actually happened (dates that slipped,
 *     questions never answered, risks that came true) — not invented by a model;
 *   - nothing crosses out of a project by itself. Promotion is an explicit, per-lesson
 *     operator action;
 *   - a promoted lesson carries its ORIGIN, so the next project always knows whose
 *     experience it is being offered, and can disagree with it.
 *
 * Pure: injected inputs, no clock, no store.
 */
import type {
  DecisionRow,
  MilestoneRow,
  OpenQuestionRow,
  ProjectBriefRow,
  RiskRow,
  TaskRow,
} from '@amrita/store';

const DAY = 86_400_000;

/** Where a lesson goes when it is promoted. `user` scope = organizational memory. */
export const ORG_MEMORY_SOURCE_PREFIX = 'retro:';

export interface RetroFinding {
  kind: 'slipped' | 'unanswered' | 'risk-realised' | 'dropped' | 'never-moved' | 'scope';
  detail: string;
  /** The lesson worth keeping, if there is one. */
  lesson?: string;
}

export interface RetroPacket {
  projectId: string;
  /** Did the project actually meet its own finish line? Honest, not flattering. */
  outcome: {
    finishLine: string | null;
    successCriteria: string[];
    tasksDone: number;
    tasksTotal: number;
    milestonesHit: number;
    milestonesMissed: number;
  };
  findings: RetroFinding[];
  /** Candidate lessons — proposals, until a human promotes one. */
  lessons: string[];
  empty: boolean;
}

export interface RetroInput {
  projectId: string;
  brief: ProjectBriefRow | null;
  tasks: readonly TaskRow[];
  milestones: readonly MilestoneRow[];
  risks: readonly RiskRow[];
  questions: readonly OpenQuestionRow[];
  decisions: readonly DecisionRow[];
  now: Date;
}

export function buildRetroPacket(input: RetroInput): RetroPacket {
  const findings: RetroFinding[] = [];
  const lessons: string[] = [];

  const live = input.tasks.filter((t) => t.status !== 'dropped');
  const done = live.filter((t) => t.status === 'done');
  const dropped = input.tasks.filter((t) => t.status === 'dropped');

  const liveMilestones = input.milestones.filter((m) => m.status !== 'dropped');
  const hit = liveMilestones.filter((m) => m.status === 'done');
  const missed = liveMilestones.filter(
    (m) => m.status !== 'done' && m.targetDate && Date.parse(m.targetDate) < input.now.getTime(),
  );

  // מה אבד — dates that slipped.
  for (const m of missed) {
    findings.push({
      kind: 'slipped',
      detail: `"${m.title}" passed its date of ${m.targetDate} without being finished.`,
      lesson: `In a project like this, "${m.title}" took longer than planned. Start it earlier, or plan for the slip.`,
    });
  }

  // מה נכשל — risks that were left open, i.e. never mitigated.
  for (const r of input.risks.filter((x) => x.status === 'open')) {
    findings.push({
      kind: 'risk-realised',
      detail: `The risk "${r.text}" was never resolved or dropped — it simply stayed open.`,
      lesson: `Watch for this early: ${r.text}`,
    });
  }

  // אילו הנחות היו שגויות — questions nobody ever answered.
  for (const q of input.questions.filter((x) => x.status === 'open')) {
    const age = Math.floor((input.now.getTime() - Date.parse(q.createdAt)) / DAY);
    findings.push({
      kind: 'unanswered',
      detail: `"${q.text}" was asked ${age} days ago and never answered. The project proceeded on an assumption.`,
      lesson: `Answer this before starting: ${q.text}`,
    });
  }

  const stuck = live.filter((t) => t.status !== 'done' && t.blockedReason);
  for (const t of stuck) {
    findings.push({
      kind: 'never-moved',
      detail: `"${t.title}" finished the project still blocked on: ${t.blockedReason}`,
      lesson: `This kind of work gets blocked on: ${t.blockedReason}. Open that track early.`,
    });
  }

  if (dropped.length > 0) {
    findings.push({
      kind: 'dropped',
      detail: `${dropped.length} task(s) were dropped rather than done — the plan was bigger than the project.`,
      lesson: 'The original plan was larger than what actually got done. Scope down sooner.',
    });
  }

  for (const f of findings) {
    if (f.lesson && !lessons.includes(f.lesson)) lessons.push(f.lesson);
  }

  return {
    projectId: input.projectId,
    outcome: {
      finishLine: input.brief?.finishLine ?? null,
      successCriteria: input.brief?.successCriteria ?? [],
      tasksDone: done.length,
      tasksTotal: live.length,
      milestonesHit: hit.length,
      milestonesMissed: missed.length,
    },
    findings,
    lessons,
    empty: findings.length === 0,
  };
}

export function renderRetroPacket(p: RetroPacket): string {
  const o = p.outcome;
  const lines: string[] = [
    'Retrospective',
    '',
    o.finishLine ? `Done meant: ${o.finishLine}` : 'There was never a finish line.',
    `Tasks: ${o.tasksDone} of ${o.tasksTotal} done. Milestones: ${o.milestonesHit} hit, ${o.milestonesMissed} missed.`,
    '',
  ];

  if (p.empty) {
    lines.push('Nothing slipped, nothing was left open. That is rare — and worth knowing.');
    return lines.join('\n');
  }

  lines.push('What happened:');
  for (const f of p.findings) lines.push(`- ${f.detail}`);

  if (p.lessons.length > 0) {
    lines.push('', 'Worth keeping:');
    for (const l of p.lessons) lines.push(`- ${l}`);
    lines.push(
      '',
      'None of this crosses into another project by itself. Promote the lessons you actually',
      'believe — each one is kept with its origin, so the next project knows whose experience it is.',
    );
  }
  return lines.join('\n');
}
