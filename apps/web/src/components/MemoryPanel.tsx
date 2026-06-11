import { useState } from 'react';
import { client } from '../client.ts';
import { type WriteCtx, textDir } from '../lib.ts';

interface MemoryEntryLite {
  id: string;
  content: string;
}

interface MemoryPanelProps {
  projectId: string | undefined;
  writeCtx: WriteCtx | null;
  onError: (e: unknown) => void;
}

/** Project memory: FTS search + a project-scoped "remember" write. */
export function MemoryPanel({ projectId, writeCtx, onError }: MemoryPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryEntryLite[]>([]);
  const [searched, setSearched] = useState(false);
  const [remember, setRemember] = useState('');

  async function search(): Promise<void> {
    if (!query.trim()) return;
    try {
      const rows = await client.call<MemoryEntryLite[]>('memory.search', {
        query,
        ...(projectId ? { projectId } : {}),
      });
      setResults(Array.isArray(rows) ? rows : []);
      setSearched(true);
    } catch (e) {
      onError(e);
    }
  }

  async function save(): Promise<void> {
    if (!writeCtx || !remember.trim()) return;
    try {
      await client.memoryPut({ ...writeCtx, scope: 'project', content: remember.trim() });
      setRemember('');
    } catch (e) {
      onError(e);
    }
  }

  return (
    <section className="card">
      <h2>Memory</h2>
      <div className="search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memory"
        />
        <button type="button" onClick={() => void search()}>
          Search
        </button>
      </div>
      {results.length === 0 && searched && query ? <p className="empty-note">No matches.</p> : null}
      {results.map((m) => (
        <p key={m.id} dir={textDir(m.content)}>
          {m.content}
        </p>
      ))}
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          value={remember}
          onChange={(e) => setRemember(e.target.value)}
          dir={textDir(remember)}
          placeholder="Remember for this project…"
        />
        <button type="submit" disabled={!remember.trim() || !writeCtx}>
          Save
        </button>
      </form>
    </section>
  );
}
