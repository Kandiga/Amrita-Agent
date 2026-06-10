import { useEffect, useMemo, useState } from 'react';
import { type AmritaEventLite, RpcClient } from './api.ts';
import {
  type ChatMessage,
  formatUsage,
  messagesFromEvents,
  safeErrorMessage,
  textDir,
} from './lib.ts';

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AmritaEventLite[]>([]);
  const [projectSlug, setProjectSlug] = useState('system');
  const [conversationId, setConversationId] = useState('');
  const [provider, setProvider] = useState('mock');
  const [draft, setDraft] = useState('');
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memory, setMemory] = useState<Memory[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedProject = useMemo(
    () => projects.find((p) => p.slug === projectSlug),
    [projects, projectSlug],
  );
  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === provider),
    [providers, provider],
  );

  async function refreshBase() {
    setError('');
    const [projectResult, providerResult] = await Promise.all([
      client.call('project.list'),
      client.call('providers.list'),
    ]);
    const nextProjects = extractArray<Project>(projectResult, ['projects']);
    setProjects(nextProjects);
    setProviders(extractArray<Provider>(providerResult, ['providers']));
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
      if (list[0]) await openConversation(list[0].id);
      else await createConversation(project.id);
      await loadTasks(project.id);
    } catch (e) {
      setError(safeErrorMessage(e));
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
    setConversationId(c.id);
    setConversations((old) => [c, ...old.filter((x) => x.id !== c.id)]);
    setMessages([]);
    setEvents([]);
  }

  async function openConversation(id: string) {
    setConversationId(id);
    const replay = await client.events(id, 0);
    setEvents(replay);
    setMessages(messagesFromEvents(replay));
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
      setError(safeErrorMessage(e));
    }
  }

  async function send() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    setError('');
    const text = draft.trim();
    setDraft('');
    const optimistic: ChatMessage = { id: `local-${Date.now()}`, role: 'user', text };
    setMessages((old) => [...old, optimistic]);
    try {
      const result = await client.call<ChatResult>('chat.turn', {
        text,
        project: projectSlug,
        conversationId: conversationId || undefined,
        provider,
      });
      if (result.conversationId && result.conversationId !== conversationId)
        setConversationId(result.conversationId);
      const assistant: ChatMessage = {
        id: `agent-${Date.now()}`,
        role: 'agent',
        text: `${result.text}\n\n_${result.provider} · ${result.model} · ${formatUsage(result.usage)}_`,
      };
      setMessages((old) => [...old.filter((m) => m.id !== optimistic.id), optimistic, assistant]);
      if (result.conversationId) {
        const replay = await client.events(result.conversationId, events.at(-1)?.seq ?? 0);
        setEvents((old) => [...old, ...replay]);
      }
    } catch (e) {
      setError(safeErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: boot once; project switching is handled by explicit UI actions.
  useEffect(() => {
    refreshBase()
      .then(() => ensureProjectAndLoad(projectSlug))
      .catch((e) => setError(safeErrorMessage(e)));
  }, []);

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
        </header>
        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty">
              <span>अ</span>
              <h1>Talk to Amrita</h1>
              <p>HTTP/RPC runtime, providers, memory and channel foundation are now connected.</p>
            </div>
          ) : null}
          {messages.map((m) => (
            <article key={m.id} className={`bubble ${m.role}`} dir={textDir(m.text)}>
              {m.text}
            </article>
          ))}
        </div>
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
