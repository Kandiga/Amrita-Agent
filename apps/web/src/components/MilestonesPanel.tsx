import { useState } from 'react';
import type { MilestoneLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface MilestonesPanelProps {
  milestones: MilestoneLite[];
  tasks: { id: string; status?: string; milestoneId?: string | null }[];
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

/** Milestones: add with optional target date, complete, open-task counts. */
export function MilestonesPanel({
  milestones,
  tasks,
  writeCtx,
  onChanged,
  onError,
}: MilestonesPanelProps) {
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState('');

  async function add(): Promise<void> {
    if (!writeCtx || !draft.trim()) return;
    try {
      await client.milestoneCreate({
        ...writeCtx,
        title: draft.trim(),
        ...(target ? { targetDate: target } : {}),
      });
      setDraft('');
      setTarget('');
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  async function complete(milestoneId: string): Promise<void> {
    if (!writeCtx) return;
    try {
      await client.milestoneComplete({ ...writeCtx, milestoneId });
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card">
      <h2>Milestones</h2>
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
          placeholder="Add a milestone…"
        />
        <input
          type="date"
          className="milestone-date"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          title="Target date (optional)"
        />
        <button type="submit" disabled={!draft.trim() || !writeCtx}>
          Add
        </button>
      </form>
      {milestones.length === 0 ? (
        <p className="empty-note">
          No milestones yet — group tasks into the next meaningful chunk of progress.
        </p>
      ) : (
        milestones.map((m) => {
          const openCount = tasks.filter(
            (t) => t.milestoneId === m.id && t.status !== 'done' && t.status !== 'dropped',
          ).length;
          return (
            <div key={m.id} className="task-row">
              <div className="task-main">
                <strong dir={textDir(m.title)}>{m.title}</strong>
                <small>
                  {m.status}
                  {m.targetDate ? ` · → ${m.targetDate}` : ''}
                  {openCount > 0 ? ` · ${openCount} open task${openCount > 1 ? 's' : ''}` : ''}
                </small>
              </div>
              {m.status !== 'done' && m.status !== 'dropped' ? (
                <button type="button" className="task-complete" onClick={() => void complete(m.id)}>
                  Done
                </button>
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}
