import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

/**
 * Bind a project to a working folder on the server (ADR-0045 §7).
 *
 * The browser NEVER picks a path — the daemon validates whatever is sent against
 * the allowed-roots allowlist it was started with (AMRITA_LANES_ALLOWED_ROOTS),
 * and returns an honest, structured error when the path is outside it or the
 * daemon was authorised to touch nothing. Without a root, a task can never be
 * delegated to a lane, which is why every project sat at root=NULL.
 */

interface Props {
  projectId: string | undefined;
  root: string | null;
  writeCtx: WriteCtx | null;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

export function WorkspacePanel({ projectId, root, writeCtx, onChanged, onError }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  async function bind(next: string | null): Promise<void> {
    if (!writeCtx) return;
    setBusy(true);
    try {
      await client.setProjectRoot({ ...writeCtx, root: next });
      setDraft('');
      onChanged();
    } catch (e) {
      // The daemon's allowlist errors are meant to be read: "outside every allowed
      // root", "no allowed roots configured", "no such folder". Surface them as-is.
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Working folder</h2>
      {root ? (
        <p className="workspace-root" dir={textDir(root)}>
          <code>{root}</code>
        </p>
      ) : (
        <p className="empty-note">
          Not bound. Until a project points at a folder the daemon was authorised to touch, its
          tasks can be discussed but not delegated to a coding lane.
        </p>
      )}
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void bind(draft.trim() || null);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          dir={textDir(draft)}
          placeholder={root ? 'Change the folder…' : 'Absolute path inside an allowed root…'}
          aria-label="Project working folder path"
          disabled={!projectId || busy}
        />
        <button type="submit" disabled={!projectId || busy || !draft.trim()}>
          {busy ? 'Binding…' : 'Bind'}
        </button>
      </form>
      {root ? (
        <button type="button" className="ghost" disabled={busy} onClick={() => void bind(null)}>
          Unbind
        </button>
      ) : null}
      <p className="hub-note">
        The server checks this against its allowed roots — the browser never reaches your
        filesystem.
      </p>
    </section>
  );
}
