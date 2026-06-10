import { useEffect, useMemo, useRef, useState } from 'react';
import { type AmritaEventLite, RpcClient, RpcError } from './api.ts';
import { clearToken, loadToken, maskToken, saveToken } from './auth.ts';
import { type ChatMessage, formatUsage, safeErrorMessage, textDir } from './lib.ts';
import {
  type TranscriptState,
  emptyTranscript,
  foldEvents,
  reduceEvent,
  transcriptMessages,
} from './live-transcript.ts';
import { type EventStreamHandle, type StreamState, openEventStream } from './stream.ts';

type Project = { id: string; slug: string; name: string };
type Conversation = { id: string; projectId: string; title?: string | null; createdAt?: string };
type Provider = {
  id: string;
  available?: boolean;
  configuredAccounts?: number;
  envReady?: boolean;
};
type Task = { id: string; title: string; status?: string };
type Memory = { id: string; content: string; score?: number };
type ChatResult = {
  conversationId: string;
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
};

const client = new RpcClient();

const STREAM_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Offline',
  closed: 'Disconnected',
};

function extractArray<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of keys) if (Array.isArray(obj[key])) return obj[key] as T[];
  }
  return [];
}

function titleFor(c: Conversation): string {
  return c.title || `Conversation ${c.id.slice(0, 8)}`;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript());
  const [pending, setPending] = useState<ChatMessage[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [projectSlug, setProjectSlug] = useState('system');
  const [conversationId, setConversationId] = useState('');
  const [provider, setProvider] = useState('mock');
  const [draft, setDraft] = useState('');
  const [lastTurn, setLastTurn] = useState('');
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memory, setMemory] = useState<Memory[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authToken, setAuthToken] = useState<string | undefined>(() => loadToken());
  const [tokenDraft, setTokenDraft] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);

  // The reducer is the single source of truth for the transcript; the stream and
  // any manual replay both feed it, de-duped by event id.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  // A 401/403 surfaces the auth panel instead of a raw error line.
  function reportError(e: unknown): void {
    if (e instanceof RpcError && e.code === 'unauthorized') {
      setUnauthorized(true);
      setError('');
    } else {
      setError(safeErrorMessage(e));
    }
  }

  // Keep the shared client's bearer token in sync with UI state (never logged).
  useEffect(() => {
    client.setAuthToken(authToken);
  }, [authToken]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.slug === projectSlug),
    [projects, projectSlug],
  );
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider],
  );

  // The visible transcript: committed messages + any optimistic user bubble not
  // yet echoed back by a real `message.user` event.
  const messages = useMemo(() => {
    const committed = transcriptMessages(transcript);
    const echoed = (text: string) => committed.some((m) => m.role === 'user' && m.text === text);
    return [...committed, ...pending.filter((p) => !echoed(p.text))];
  }, [transcript, pending]);

  // Live subscription: (re)open whenever the selected conversation changes.
  useEffect(() => {
    if (!conversationId) return;
    setTranscript(emptyTranscript());
    setPending([]);
    setStreamState('connecting');
    let handle: EventStreamHandle | null = null;
    handle = openEventStream(
      conversationId,
      {
        onEvent: (ev) => setTranscript((s) => reduceEvent(s, ev)),
        onState: (s) => setStreamState(s),
      },
      { sinceSeq: 0, ...(authToken ? { token: authToken } : {}) },
    );
    return () => handle?.close();
  }, [conversationId, authToken]);

  async function refreshBase() {
    setError('');
    const [projectResult, providerResult] = await Promise.all([
      client.call('project.list'),
      client.call('providers.list'),
    ]);
    const nextProjects = extractArray<Project>(projectResult, ['projects']);
    setProjects(nextProjects);
    setProviders(extractArray<Provider>(providerResult, ['providers']));
    setUnauthorized(false); // a successful load means the token (if any) is accepted
    if (nextProjects.length > 0 && !nextProjects.some((p) => p.slug === projectSlug))
      setProjectSlug(nextProjects[0]?.slug ?? 'system');
  }

  async function ensureProjectAndLoad(slug: string) {
    setBusy(true);
    try {
      const ensured = (await client.call('project.ensure', {
        slug,
        name: slug === 'system' ? 'System' : slug,
      })) as { project?: Project } | Project;
      const project =
        'project' in ensured && ensured.project ? ensured.project : (ensured as Project);
      setProjectSlug(project.slug);
      const listResult = await client.call('conversation.list', { projectId: project.id });
      const list = extractArray<Conversation>(listResult, ['conversations']);
      setConversations(list);
      if (list[0]) openConversation(list[0].id);
      else await createConversation(project.id);
      await loadTasks(project.id);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  async function createConversation(projectId = selectedProject?.id) {
    if (!projectId) return;
    const result = (await client.call('conversation.create', { projectId, title: 'New chat' })) as
      | { conversation?: Conversation }
      | Conversation;
    const c =
      'conversation' in result && result.conversation
        ? result.conversation
        : (result as Conversation);
    setConversations((old) => [c, ...old.filter((x) => x.id !== c.id)]);
    openConversation(c.id);
  }

  function openConversation(id: string) {
    // Switching the id resets the transcript and reopens the stream (effect above).
    setConversationId(id);
  }

  /** Manual replay fallback — folds `GET /events` into the reducer (de-duped). */
  async function refreshTranscript() {
    if (!conversationId) return;
    try {
      const replay = await client.events(conversationId, 0);
      setTranscript(foldEvents(emptyTranscript(), replay));
    } catch (e) {
      reportError(e);
    }
  }

  async function loadTasks(projectId = selectedProject?.id) {
    if (!projectId) return;
    const result = await client.call('tasks.list', { projectId });
    setTasks(extractArray<Task>(result, ['tasks']));
  }

  async function searchMemory() {
    if (!memoryQuery.trim()) return;
    setError('');
    try {
      const result = await client.call('memory.search', {
        query: memoryQuery,
        projectId: selectedProject?.id,
      });
      setMemory(extractArray<Memory>(result, ['entries', 'memory', 'results']));
    } catch (e) {
      reportError(e);
    }
  }

  function applyToken(): void {
    const next = tokenDraft.trim() || undefined;
    saveToken(next ?? '');
    setAuthToken(next);
    setTokenDraft('');
    setUnauthorized(false);
  }

  function forgetToken(): void {
    clearToken();
    setAuthToken(undefined);
    setTokenDraft('');
  }

  async function send() {
    if (!draft.trim() || busy || !conversationId) return;
    setBusy(true);
    setError('');
    const text = draft.trim();
    setDraft('');
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', text };
    setPending((old) => [...old, optimistic]);
    try {
      const result = await client.call<ChatResult>('chat.turn', {
        text,
        conversationId,
        provider,
      });
      setLastTurn(`${result.provider} · ${result.model} · ${formatUsage(result.usage)}`);
      // Fallback replay: if the live socket is offline, this still lands the turn;
      // when it is live, the reducer de-dupes the overlap by event id.
      const replay = await client.events(result.conversationId, transcriptRef.current.lastSeq);
      setTranscript((s) => foldEvents(s, replay));
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: boot + reload when the token changes; project switching is handled by explicit UI actions.
  useEffect(() => {
    refreshBase()
      .then(() => ensureProjectAndLoad(projectSlug))
      .catch((e) => reportError(e));
  }, [authToken]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="mark">अ</span>
          <div>
            <strong>Amrita</strong>
            <small>runtime console</small>
          </div>
        </div>
        <button
          className="primary"
          type="button"
          onClick={() => ensureProjectAndLoad(projectSlug)}
          disabled={busy}
        >
          Refresh
        </button>
        <section>
          <h2>Projects</h2>
          <div className="list">
            {projects.map((p) => (
              <button
                type="button"
                key={p.id}
                className={p.slug === projectSlug ? 'active' : ''}
                onClick={() => ensureProjectAndLoad(p.slug)}
              >
                {p.name}
                <small>{p.slug}</small>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>Conversations</h2>
          <button
            type="button"
            onClick={() => createConversation()}
            disabled={!selectedProject || busy}
          >
            + New chat
          </button>
          <div className="list">
            {conversations.map((c) => (
              <button
                type="button"
                key={c.id}
                className={c.id === conversationId ? 'active' : ''}
                onClick={() => openConversation(c.id)}
              >
                {titleFor(c)}
                <small>{c.id.slice(0, 12)}</small>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div>
            <strong>{selectedProject?.name ?? projectSlug}</strong>
            <small>
              {conversationId ? `conversation ${conversationId.slice(0, 12)}` : 'ready'}
            </small>
          </div>
          <div className="topbar-controls">
            <button
              type="button"
              className={`conn conn-${streamState}`}
              onClick={refreshTranscript}
              title="Connection state — click to replay from the daemon"
            >
              <span className="dot" />
              {STREAM_LABELS[streamState]}
            </button>
            <label>
              Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                    {p.available === false ? ' (unavailable)' : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty">
              <span>अ</span>
              <h1>Talk to Amrita</h1>
              <p>The transcript now streams live from the runtime over a WebSocket.</p>
            </div>
          ) : null}
          {messages.map((m) => (
            <article
              key={m.id}
              className={`bubble ${m.role}${m.pending ? ' pending' : ''}`}
              dir={textDir(m.text)}
            >
              {m.text}
              {m.pending ? <span className="caret" /> : null}
            </article>
          ))}
        </div>
        {lastTurn ? <div className="turn-meta">{lastTurn}</div> : null}
        {unauthorized ? (
          <div className="error" role="alert">
            Unauthorized — set a valid access token in the panel on the right to reach the runtime.
          </div>
        ) : null}
        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            dir={textDir(draft)}
            placeholder="Message Amrita…"
            rows={2}
          />
          <button type="submit" disabled={busy || !draft.trim()}>
            {busy ? '…' : 'Send'}
          </button>
        </form>
      </section>

      <aside className="inspector">
        <section className={`card auth-card${unauthorized ? ' needs-auth' : ''}`}>
          <h2>Access token</h2>
          <p className={authToken ? 'token-set' : ''}>
            {authToken
              ? `token set · ${maskToken(authToken)}`
              : 'No token set — the runtime may require one.'}
          </p>
          <div className="search">
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="Paste bearer token"
              autoComplete="off"
            />
            <button type="button" onClick={applyToken} disabled={!tokenDraft.trim()}>
              Save
            </button>
          </div>
          {authToken ? (
            <button type="button" onClick={forgetToken}>
              Clear token
            </button>
          ) : null}
        </section>
        <section className="card">
          <h2>Provider status</h2>
          <div className="provider-row">
            <strong>{selectedProvider?.id ?? provider}</strong>
            <span>{selectedProvider?.available === false ? 'unavailable' : 'available'}</span>
          </div>
          <p>
            configured: {selectedProvider?.configuredAccounts ?? 0} · env:{' '}
            {selectedProvider?.envReady ? 'ready' : 'not needed / missing'}
          </p>
        </section>
        <section className="card">
          <h2>Memory</h2>
          <div className="search">
            <input
              value={memoryQuery}
              onChange={(e) => setMemoryQuery(e.target.value)}
              placeholder="Search memory"
            />
            <button type="button" onClick={searchMemory}>
              Search
            </button>
          </div>
          {memory.map((m) => (
            <p key={m.id}>{m.content}</p>
          ))}
        </section>
        <section className="card">
          <h2>Tasks</h2>
          {tasks.length === 0 ? (
            <p>No tasks yet.</p>
          ) : (
            tasks.map((t) => (
              <p key={t.id}>
                <strong>{t.title}</strong>
                <br />
                <small>{t.status}</small>
              </p>
            ))
          )}
        </section>
        <section className="card">
          <h2>Lanes</h2>
          <p>
            Claude Code, Telegram and tool lanes are reserved for the next production checkpoints.
          </p>
        </section>
      </aside>
    </main>
  );
}
