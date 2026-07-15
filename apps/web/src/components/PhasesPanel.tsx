import type { PhaseRowWire } from '@amrita/protocol';
import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * Phases editor (WP9). Activation seeds the project's phases; this is the only
 * way to add or rename one afterwards. The board's columns ARE these phases, so
 * editing here reshapes the board (ADR-0045: "the board is born from the project").
 */

interface Props {
  phases: PhaseRowWire[];
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

export function PhasesPanel({ phases, writeCtx, onChanged, onError }: Props) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  async function add(): Promise<void> {
    if (!writeCtx || !title.trim()) return;
    setBusy(true);
    try {
      await client.phaseCreate({ ...writeCtx, title: title.trim() });
      setTitle('');
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function rename(phaseId: string): Promise<void> {
    if (!writeCtx || !editTitle.trim()) return;
    setBusy(true);
    try {
      await client.phaseUpdate({ ...writeCtx, phaseId, title: editTitle.trim() });
      setEditing(null);
      onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Phases</h2>
      {phases.length === 0 ? (
        <p className="empty-note">
          No phases yet — a project gets its phases when it is activated. Add one here to shape the
          board.
        </p>
      ) : (
        <ul className="channel-list">
          {phases.map((p) => (
            <li key={p.id} className="channel-row">
              {editing === p.id ? (
                <form
                  className="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename(p.id);
                  }}
                >
                  <input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    dir={textDir(editTitle)}
                    // biome-ignore lint/a11y/noAutofocus: only present after the operator clicks Rename
                    autoFocus
                  />
                  <button type="submit" disabled={busy || !editTitle.trim()}>
                    Save
                  </button>
                </form>
              ) : (
                <>
                  <div className="channel-copy">
                    <strong dir={textDir(p.title)}>{p.title}</strong>
                    <small>{p.status}</small>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    disabled={!writeCtx || busy}
                    onClick={() => {
                      setEditing(p.id);
                      setEditTitle(p.title);
                    }}
                  >
                    Rename
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          dir={textDir(title)}
          placeholder="Add a phase…"
          disabled={!writeCtx || busy}
        />
        <button type="submit" disabled={!writeCtx || busy || !title.trim()}>
          Add
        </button>
      </form>
    </section>
  );
}
