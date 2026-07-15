import type { CharterStatusWire } from '@amrita/protocol';
import { useState } from 'react';
import type { BriefLite } from '../api.ts';
import {
  constraintLabel,
  formatConstraints,
  formatDecisionRights,
  parseConstraints,
  parseDecisionRights,
} from '../charter.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface BriefPanelProps {
  brief: BriefLite | null;
  /** The COMPUTED critique (ADR-0045) — never a model's opinion. */
  charter?: CharterStatusWire | null;
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

function parseLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * The project brief + charter: view and full-document edit form (ADR-0018/0044).
 *
 * `brief.updated` carries the WHOLE document, so this form must send every field
 * back — including the charter. Omitting one does not leave it alone, it CLEARS
 * it (a store test pins that behavior). Hence `startEdit` seeds all of them.
 */
export function BriefPanel({ brief, charter, writeCtx, onChanged, onError }: BriefPanelProps) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState('');
  const [criteria, setCriteria] = useState('');
  const [scope, setScope] = useState('');
  const [noScope, setNoScope] = useState('');
  const [finishLine, setFinishLine] = useState('');
  const [constraints, setConstraints] = useState('');
  const [rights, setRights] = useState('');
  /**
   * ADR-0045: the brief `version` as it was when this edit STARTED. The brief is a
   * full-document upsert, so saving over a version someone else already changed
   * would not lose a field — it would wipe their whole charter. Send it back and
   * the daemon refuses a stale save.
   */
  const [seenVersion, setSeenVersion] = useState<number | null>(null);

  function startEdit(): void {
    setGoal(brief?.goal ?? '');
    setAudience(brief?.audience ?? '');
    setCriteria((brief?.successCriteria ?? []).join('\n'));
    setScope((brief?.scope ?? []).join('\n'));
    setNoScope((brief?.noScope ?? []).join('\n'));
    setFinishLine(brief?.finishLine ?? '');
    setConstraints(formatConstraints(brief?.constraints ?? []));
    setRights(formatDecisionRights(brief?.decisionRights ?? []));
    setSeenVersion(brief?.version ?? null);
    setEditing(true);
  }

  async function save(): Promise<void> {
    if (!writeCtx || !goal.trim()) return;
    try {
      await client.briefUpdate({
        ...writeCtx,
        goal: goal.trim(),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        successCriteria: parseLines(criteria),
        scope: parseLines(scope),
        noScope: parseLines(noScope),
        // full-document: always send the charter back, or it is cleared
        ...(finishLine.trim() ? { finishLine: finishLine.trim() } : {}),
        constraints: parseConstraints(constraints),
        decisionRights: parseDecisionRights(rights),
        ...(seenVersion !== null ? { expectedVersion: seenVersion } : {}),
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  const findings = charter?.findings ?? [];

  return (
    <section className="card">
      <h2>Charter</h2>
      {editing ? (
        <form
          className="brief-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            dir={textDir(goal)}
            placeholder="What is this project for?"
            rows={2}
          />
          <input
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            dir={textDir(audience)}
            placeholder="Who is it for? (optional)"
          />
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            dir={textDir(criteria)}
            placeholder={'Success criteria — one per line'}
            rows={2}
          />
          <textarea
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            dir={textDir(scope)}
            placeholder={'In scope — one per line'}
            rows={2}
          />
          <textarea
            value={noScope}
            onChange={(e) => setNoScope(e.target.value)}
            dir={textDir(noScope)}
            placeholder={'Out of scope — one per line'}
            rows={2}
          />
          <input
            value={finishLine}
            onChange={(e) => setFinishLine(e.target.value)}
            dir={textDir(finishLine)}
            placeholder="Done means… (the finish line)"
          />
          <textarea
            value={constraints}
            onChange={(e) => setConstraints(e.target.value)}
            dir={textDir(constraints)}
            placeholder={
              'Constraints — one per line\nbudget: $15K net (hard)\ndate: third Saturday of October (hard)'
            }
            rows={3}
          />
          <textarea
            value={rights}
            onChange={(e) => setRights(e.target.value)}
            dir={textDir(rights)}
            placeholder={'Who approves what — one per line\nvendor list -> the arts council'}
            rows={2}
          />
          <div className="brief-actions">
            <button type="submit" disabled={!goal.trim()}>
              Save brief
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : brief ? (
        <div className="brief-view">
          <p className="brief-goal" dir={textDir(brief.goal)}>
            {brief.goal}
          </p>
          {brief.audience ? <small>for {brief.audience}</small> : null}
          {brief.successCriteria.length > 0 ? (
            <ul>
              {brief.successCriteria.map((s) => (
                <li key={s} dir={textDir(s)}>
                  {s}
                </li>
              ))}
            </ul>
          ) : null}
          {brief.scope.length > 0 ? (
            <p className="brief-scope">
              <strong>In:</strong> {brief.scope.join(' · ')}
            </p>
          ) : null}
          {brief.noScope.length > 0 ? (
            <p className="brief-scope">
              <strong>Out:</strong> {brief.noScope.join(' · ')}
            </p>
          ) : null}
          {brief.finishLine ? (
            <p className="brief-scope" dir={textDir(brief.finishLine)}>
              <strong>Done means:</strong> {brief.finishLine}
            </p>
          ) : null}
          {brief.constraints.length > 0 ? (
            <p className="brief-scope">
              <strong>Constraints:</strong>{' '}
              {brief.constraints.map((c) => constraintLabel(c)).join(' · ')}
            </p>
          ) : null}
          {brief.decisionRights.length > 0 ? (
            <p className="brief-scope">
              <strong>Approvals:</strong>{' '}
              {brief.decisionRights.map((r) => `${r.area} → ${r.approver}`).join(' · ')}
            </p>
          ) : null}
          {/* ודאות / חוסר / סתירה — computed, not guessed (ADR-0045). */}
          {findings.length > 0 && (
            <ul className="charter-findings">
              {findings.slice(0, 4).map((f) => (
                <li key={`${f.kind}:${f.field}:${f.detail}`} className="charter-finding">
                  <span className={`charter-mark ${f.kind}`}>
                    {f.kind === 'missing'
                      ? 'missing'
                      : f.kind === 'unconfirmed'
                        ? 'unconfirmed'
                        : 'conflict'}
                  </span>
                  <span dir="auto">{f.detail}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={startEdit}>
            Edit charter
          </button>
        </div>
      ) : (
        <div className="brief-view">
          <p className="empty-note">
            No project brief yet. Capture the goal and what done looks like — next actions and
            planning hang off it.
          </p>
          <button type="button" onClick={startEdit} disabled={!writeCtx}>
            Write the brief
          </button>
        </div>
      )}
    </section>
  );
}
