import { useState } from 'react';
import type { BriefLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface BriefPanelProps {
  brief: BriefLite | null;
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

/** The project brief: view + full-document edit form (ADR-0018). */
export function BriefPanel({ brief, writeCtx, onChanged, onError }: BriefPanelProps) {
  const [editing, setEditing] = useState(false);
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState('');
  const [criteria, setCriteria] = useState('');
  const [scope, setScope] = useState('');
  const [noScope, setNoScope] = useState('');

  function startEdit(): void {
    setGoal(brief?.goal ?? '');
    setAudience(brief?.audience ?? '');
    setCriteria((brief?.successCriteria ?? []).join('\n'));
    setScope((brief?.scope ?? []).join('\n'));
    setNoScope((brief?.noScope ?? []).join('\n'));
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
      });
      setEditing(false);
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card">
      <h2>Brief</h2>
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
          <button type="button" onClick={startEdit}>
            Edit brief
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
