import { useState } from 'react';
import type { DecisionRowLite } from '../api.ts';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface DecisionsPanelProps {
  decisions: DecisionRowLite[];
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

/** The append-only decision log: list + record. */
export function DecisionsPanel({ decisions, writeCtx, onChanged, onError }: DecisionsPanelProps) {
  const [draft, setDraft] = useState('');

  async function record(): Promise<void> {
    if (!writeCtx || !draft.trim()) return;
    try {
      await client.decisionsRecord({ ...writeCtx, text: draft.trim() });
      setDraft('');
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card">
      <h2>Decisions</h2>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void record();
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          dir={textDir(draft)}
          placeholder="Record a decision…"
        />
        <button type="submit" disabled={!draft.trim() || !writeCtx}>
          Record
        </button>
      </form>
      {decisions.length === 0 ? (
        <p className="empty-note">No decisions recorded yet.</p>
      ) : (
        decisions.map((d) => (
          <p key={d.id} className="decision-row" dir={textDir(d.text)}>
            {d.text}
          </p>
        ))
      )}
    </section>
  );
}
