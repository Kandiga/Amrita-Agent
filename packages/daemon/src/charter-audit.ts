/**
 * The charter audit (ADR-0045) — Amrita's critique, as code.
 *
 * From the product brief (voice, file 02):
 *
 *   "אחרי כמה שאלות היא לא רק מסכמת, היא מפעילה ביקורת. היא אומרת למשל, כדי להגיע
 *    ליעד הזה בזמן ובתקציב הזה, חסר בעל תפקיד. יש התנגשות בין שני אישורים או
 *    שהמספרים אינם מסתדרים. היא צריכה להצביע על המגבלה שהכי סביר שתשבור את הפרויקט
 *    ולהסביר למה. זה ההבדל בין עוזרת שמצייתת לבין מנהלת שמפעילה שיקול דעת."
 *
 *   "כל אזור מתמלא בהדרגה ומוצג סימון ברור של ודאות, חוסר וסתירה."
 *
 * A prompt can *ask* a model to notice a contradiction. It cannot *guarantee* it.
 * So the findings a machine can determine — a missing approver, two conflicting
 * hard dates, an unconfirmed guess sitting in the charter — are computed HERE,
 * deterministically, and handed to the model as facts. The model is then free to
 * do the part only it can do: judge which constraint is most likely to break the
 * project, and say why.
 *
 * Pure: every input is injected, no clock, no store. Therefore testable, and
 * therefore actually true.
 */
import type { Certainty, ProjectConstraint } from '@amrita/protocol';
import type { OpenQuestionRow, ProjectBriefRow, RiskRow, TaskRow } from '@amrita/store';

/** The three markers the charter UI shows per area (ודאות / חוסר / סתירה). */
export type CharterFindingKind =
  /** A required part of the charter is simply absent. */
  | 'missing'
  /** It is present but Amrita GUESSED it — a hypothesis wearing a fact's clothes. */
  | 'unconfirmed'
  /** Two things in the charter cannot both be true. */
  | 'contradiction';

export type CharterSeverity = 'low' | 'medium' | 'high';

export interface CharterFinding {
  kind: CharterFindingKind;
  severity: CharterSeverity;
  /** Which area of the charter — the UI marks this field. */
  field: string;
  detail: string;
  /** The question to ask the operator, when the fix is to ask. */
  ask?: string;
}

export interface CharterAuditInput {
  brief: ProjectBriefRow | null;
  tasks: readonly TaskRow[];
  risks: readonly RiskRow[];
  questions: readonly OpenQuestionRow[];
}

const hardOf = (cs: readonly ProjectConstraint[], kind: ProjectConstraint['kind']) =>
  cs.filter((c) => c.kind === kind && c.hard);

/** Is this charter field an unconfirmed guess? */
function unconfirmed(certainty: Record<string, Certainty>, field: string): boolean {
  return certainty[field] === 'inferred';
}

/**
 * Audit the charter. Findings are ordered most-severe first, so the caller can
 * take the top N without re-sorting.
 */
export function auditCharter(input: CharterAuditInput): CharterFinding[] {
  const out: CharterFinding[] = [];
  const b = input.brief;

  if (!b) {
    return [
      {
        kind: 'missing',
        severity: 'high',
        field: 'goal',
        detail: 'There is no brief at all — the project has no stated goal.',
        ask: 'What does a successful outcome look like? One sentence is enough to start.',
      },
    ];
  }

  const certainty = b.certainty ?? {};

  // ── חוסר — what a plan cannot be accountable without ──────────────────────
  if (!b.finishLine) {
    out.push({
      kind: 'missing',
      severity: 'high',
      field: 'finishLine',
      detail: 'No finish line. Without it, "done" is a matter of opinion.',
      ask: 'What exactly has to be true for this project to be finished?',
    });
  }
  if (b.constraints.length === 0) {
    out.push({
      kind: 'missing',
      severity: 'high',
      field: 'constraints',
      detail: 'No constraints. A plan with no budget, date or policy cannot be stress-tested.',
      ask: 'What is the budget, and what is the hard date?',
    });
  }
  if (b.successCriteria.length === 0) {
    out.push({
      kind: 'missing',
      severity: 'medium',
      field: 'successCriteria',
      detail: 'No success criteria — nothing to measure the outcome against.',
      ask: 'How will you know this went well rather than merely finishing?',
    });
  }

  // "חסר בעל תפקיד" — money is committed but nobody is named to approve it.
  const hasBudget = b.constraints.some((c) => c.kind === 'budget');
  const approvesSpend = b.decisionRights.some((r) => /budget|spend|money|תקציב|כסף/i.test(r.area));
  if (hasBudget && b.decisionRights.length === 0) {
    out.push({
      kind: 'missing',
      severity: 'high',
      field: 'decisionRights',
      detail: 'There is a budget but nobody is authorised to approve anything.',
      ask: 'Who signs off on spending?',
    });
  } else if (hasBudget && !approvesSpend) {
    out.push({
      kind: 'missing',
      severity: 'medium',
      field: 'decisionRights',
      detail: 'There is a budget, but no decision right covers spending.',
      ask: 'Who approves spend against this budget?',
    });
  }

  // ── סתירה — things that cannot both be true ───────────────────────────────

  // Two HARD dates. One of them is going to break.
  const hardDates = hardOf(b.constraints, 'date');
  if (hardDates.length > 1) {
    out.push({
      kind: 'contradiction',
      severity: 'high',
      field: 'constraints',
      detail: `Two or more dates are marked as fixed: ${hardDates.map((c) => c.text).join(' / ')}. If they disagree, one of them is not actually fixed.`,
      ask: 'Which of these dates is genuinely immovable, and which can give?',
    });
  }

  // "התנגשות בין שני אישורים" — the same area, two different approvers.
  const byArea = new Map<string, Set<string>>();
  for (const r of b.decisionRights) {
    const key = r.area.trim().toLowerCase();
    const set = byArea.get(key) ?? new Set<string>();
    set.add(r.approver.trim());
    byArea.set(key, set);
  }
  for (const [area, approvers] of byArea) {
    if (approvers.size > 1) {
      out.push({
        kind: 'contradiction',
        severity: 'high',
        field: 'decisionRights',
        detail: `Two people are said to approve "${area}": ${[...approvers].join(' and ')}. Competing veto power stalls a project.`,
        ask: `Who has the final word on ${area}?`,
      });
    }
  }

  // Everything is negotiable ⇒ nothing is a constraint.
  if (b.constraints.length > 0 && b.constraints.every((c) => !c.hard)) {
    out.push({
      kind: 'contradiction',
      severity: 'medium',
      field: 'constraints',
      detail:
        'Every constraint is marked negotiable. If nothing is fixed, none of these are really constraints.',
      ask: 'Which single constraint is genuinely immovable?',
    });
  }

  // Scope and no-scope claiming the same thing.
  const noScope = new Set(b.noScope.map((s) => s.trim().toLowerCase()));
  for (const s of b.scope) {
    if (noScope.has(s.trim().toLowerCase())) {
      out.push({
        kind: 'contradiction',
        severity: 'medium',
        field: 'scope',
        detail: `"${s}" is listed as both in scope and out of scope.`,
        ask: `Is "${s}" in or out?`,
      });
    }
  }

  // ── ודאות — a guess sitting in the charter as though you had said it ──────
  for (const field of [
    'goal',
    'finishLine',
    'audience',
    'successCriteria',
    'constraints',
    'decisionRights',
  ]) {
    if (unconfirmed(certainty, field)) {
      out.push({
        kind: 'unconfirmed',
        severity: field === 'goal' || field === 'finishLine' ? 'high' : 'medium',
        field,
        detail: `Amrita inferred "${field}" — you have not confirmed it. It is a hypothesis, not a fact.`,
        ask: `Is Amrita's understanding of ${field} correct?`,
      });
    }
  }

  const rank: Record<CharterSeverity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b2) => rank[a.severity] - rank[b2.severity]);
}

/**
 * Has the charter enough basis to ACTIVATE the project (ADR-0045 / slice 5.3)?
 *
 * "כאשר יש מספיק בסיס, אמריטה מציעה להפעיל את הפרויקט."
 *
 * Deliberately a low bar — a goal, a finish line, and at least one constraint. The
 * point is not to gate the operator behind a perfect charter; it is to refuse to
 * conjure a board out of nothing.
 */
export function readyToActivate(brief: ProjectBriefRow | null): boolean {
  if (!brief) return false;
  return Boolean(brief.goal && brief.finishLine && brief.constraints.length > 0);
}
