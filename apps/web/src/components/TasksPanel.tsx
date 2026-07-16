import { useState } from 'react';
import type { AcceptanceCriterionLite, MilestoneLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';
import { criterionLabel, evidenceView, parseCriteria } from '../task-evidence.ts';

interface TaskLite {
  id: string;
  title: string;
  status?: string;
  milestoneId?: string | null;
  /** ADR-0055 — evidence-based done (raw JSON columns). */
  acceptanceJson?: string | null;
  verificationJson?: string | null;
}

interface TasksPanelProps {
  tasks: TaskLite[];
  milestones: MilestoneLite[];
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

/** Tasks: add (optionally into a live milestone) and complete. */
export function TasksPanel({ tasks, milestones, writeCtx, onChanged, onError }: TasksPanelProps) {
  const [draft, setDraft] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const liveMilestones = milestones.filter((m) => m.status !== 'done' && m.status !== 'dropped');

  async function add(): Promise<void> {
    if (!writeCtx || !draft.trim()) return;
    try {
      await client.tasksCreate({
        ...writeCtx,
        title: draft.trim(),
        ...(milestoneId ? { milestoneId } : {}),
      });
      setDraft('');
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  async function complete(taskId: string): Promise<void> {
    if (!writeCtx) return;
    try {
      await client.tasksComplete({ ...writeCtx, taskId });
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  /** ADR-0055 — criteria editor state (one open editor at a time keeps it calm). */
  const [editing, setEditing] = useState<string | null>(null);
  const [critKind, setCritKind] = useState<'file' | 'command' | 'manual'>('command');
  const [critText, setCritText] = useState('');
  const [verifying, setVerifying] = useState<string | null>(null);

  async function addCriterion(task: TaskLite): Promise<void> {
    if (!writeCtx || !critText.trim()) return;
    const text = critText.trim();
    const next: AcceptanceCriterionLite =
      critKind === 'file'
        ? { kind: 'file', path: text }
        : critKind === 'command'
          ? { kind: 'command', run: text }
          : { kind: 'manual', text };
    try {
      await client.tasksUpdate({
        ...writeCtx,
        taskId: task.id,
        acceptance: [...parseCriteria(task.acceptanceJson), next],
      });
      setCritText('');
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  async function removeCriterion(task: TaskLite, index: number): Promise<void> {
    if (!writeCtx) return;
    try {
      await client.tasksUpdate({
        ...writeCtx,
        taskId: task.id,
        acceptance: parseCriteria(task.acceptanceJson).filter((_, i) => i !== index),
      });
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  async function verify(taskId: string): Promise<void> {
    if (!writeCtx || verifying) return;
    setVerifying(taskId);
    try {
      // Command checks pause at the approval gate — the Approvals card is where
      // the run gets allowed; the result lands back on the task row.
      await client.tasksVerify({ ...writeCtx, taskId });
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setVerifying(null);
    }
  }

  return (
    <section className="card">
      <h2>Tasks</h2>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          dir={textDir(draft)}
          placeholder="Add a task…"
        />
        <button type="submit" disabled={!draft.trim() || !writeCtx}>
          Add
        </button>
      </form>
      {liveMilestones.length > 0 ? (
        <label className="task-milestone">
          Milestone for new tasks
          <select value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
            <option value="">(none)</option>
            {liveMilestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {tasks.length === 0 ? (
        <p className="empty-note">No tasks yet.</p>
      ) : (
        tasks.map((t) => {
          const ev = evidenceView(t.acceptanceJson, t.verificationJson);
          const open = editing === t.id;
          return (
            <div key={t.id} className={`task-row${t.status === 'done' ? ' task-done' : ''}`}>
              <div className="task-main">
                <strong dir={textDir(t.title)}>{t.title}</strong>
                <small>{t.status}</small>
                {ev.verified ? (
                  <span
                    className={`task-evidence ${ev.verified.passed ? 'evidence-pass' : 'evidence-fail'}`}
                    title={`verified ${ev.verified.at}`}
                  >
                    {ev.verified.passed ? '✓' : '✗'} {ev.verified.okCount}/{ev.verified.total}{' '}
                    checks
                  </span>
                ) : ev.criteria.length > 0 ? (
                  <span className="task-evidence evidence-unverified">
                    {ev.criteria.length} criteria · unverified
                  </span>
                ) : null}
              </div>
              <div className="task-actions">
                {ev.machineCount > 0 && t.status !== 'done' && t.status !== 'dropped' ? (
                  <button
                    type="button"
                    className="task-verify"
                    disabled={verifying !== null}
                    onClick={() => void verify(t.id)}
                  >
                    {verifying === t.id ? 'Verifying…' : 'Verify'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="task-criteria-toggle"
                  onClick={() => setEditing(open ? null : t.id)}
                >
                  {open ? 'Close' : 'Checks'}
                </button>
                {t.status !== 'done' && t.status !== 'dropped' ? (
                  <button
                    type="button"
                    className="task-complete"
                    onClick={() => void complete(t.id)}
                  >
                    Done
                  </button>
                ) : null}
              </div>
              {open ? (
                <div className="task-criteria">
                  {ev.criteria.length === 0 ? (
                    <p className="muted">
                      No acceptance checks yet — add a gate command, a required file, or a manual
                      note. Done becomes evidence, not belief.
                    </p>
                  ) : (
                    <ul>
                      {ev.criteria.map((c, i) => (
                        <li key={criterionLabel(c)}>
                          <code dir="ltr">{criterionLabel(c)}</code>
                          <button type="button" onClick={() => void removeCriterion(t, i)}>
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="task-criteria-add">
                    <select
                      value={critKind}
                      onChange={(e) =>
                        setCritKind(
                          e.target.value === 'file'
                            ? 'file'
                            : e.target.value === 'manual'
                              ? 'manual'
                              : 'command',
                        )
                      }
                    >
                      <option value="command">command (exit 0)</option>
                      <option value="file">file exists</option>
                      <option value="manual">manual</option>
                    </select>
                    <input
                      value={critText}
                      dir="ltr"
                      onChange={(e) => setCritText(e.target.value)}
                      placeholder={
                        critKind === 'command'
                          ? 'pnpm test'
                          : critKind === 'file'
                            ? 'dist/index.html'
                            : 'reads well in Hebrew'
                      }
                    />
                    <button
                      type="button"
                      disabled={!critText.trim()}
                      onClick={() => void addCriterion(t)}
                    >
                      Add
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
