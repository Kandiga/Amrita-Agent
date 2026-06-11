import { useState } from 'react';
import type { MilestoneLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface TaskLite {
  id: string;
  title: string;
  status?: string;
  milestoneId?: string | null;
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
        tasks.map((t) => (
          <div key={t.id} className={`task-row${t.status === 'done' ? ' task-done' : ''}`}>
            <div className="task-main">
              <strong dir={textDir(t.title)}>{t.title}</strong>
              <small>{t.status}</small>
            </div>
            {t.status !== 'done' && t.status !== 'dropped' ? (
              <button type="button" className="task-complete" onClick={() => void complete(t.id)}>
                Done
              </button>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
