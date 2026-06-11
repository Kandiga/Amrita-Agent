import { useEffect, useMemo, useRef, useState } from 'react';
import { type AmritaEventLite, type DecisionRowLite, RpcClient, RpcError } from './api.ts';
import { clearToken, loadToken, maskToken, saveToken } from './auth.ts';
import {
  type LanesState,
  emptyLanes,
  foldLaneEvents,
  isActive,
  lanesList,
  reduceLaneEvent,
} from './lanes-state.ts';
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
type DoctorCheck = { id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail?: string };
type DoctorReport = {
  ok: boolean;
  status: 'ok' | 'warn' | 'fail';
  sections: { title: string; checks: DoctorCheck[] }[];
  fixes: string[];
};
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
  const [lanes, setLanes] = useState<LanesState>(emptyLanes());
  const [laneGoal, setLaneGoal] = useState('');
  const [laneDryRun, setLaneDryRun] = useState(true);
  const [laneReal, setLaneReal] = useState(false);
  const [laneMaxTurns, setLaneMaxTurns] = useState('');
  const [laneMaxMinutes, setLaneMaxMinutes] = useState('');
  const [realExecAvailable, setRealExecAvailable] = useState(false);
  const [laneBusy, setLaneBusy] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const [decisions, setDecisions] = useState<DecisionRowLite[]>([]);
  const [decisionDraft, setDecisionDraft] = useState('');
  const [taskDraft, setTaskDraft] = useState('');
  const [rememberDraft, setRememberDraft] = useState('');

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

  const laneViews = useMemo(() => lanesList(lanes), [lanes]);

  // Live subscription: (re)open whenever the selected conversation changes. The
  // same event stream feeds the transcript and the Lanes panel.
  useEffect(() => {
    if (!conversationId) return;
    setTranscript(emptyTranscript());
    setLanes(emptyLanes());
    setPending([]);
    setStreamState('connecting');
    let handle: EventStreamHandle | null = null;
    handle = openEventStream(
      conversationId,
      {
        onEvent: (ev) => {
          setTranscript((s) => reduceEvent(s, ev));
          setLanes((s) => reduceLaneEvent(s, ev));
        },
        onState: (s) => setStreamState(s),
      },
      { sinceSeq: 0, ...(authToken ? { token: authToken } : {}) },
    );
    return () => handle?.close();
  }, [conversationId, authToken]);

  async function refreshBase() {
    setError('');
    const [projectResult, providerResult, healthResult, doctorResult] = await Promise.all([
      client.call('project.list'),
      client.call('providers.list'),
      client.call('health'),
      client.call<DoctorReport>('doctor'),
    ]);
    const nextProjects = extractArray<Project>(projectResult, ['projects']);
    setProjects(nextProjects);
    setProviders(extractArray<Provider>(providerResult, ['providers']));
    const health = healthResult as { lanes?: { realExecution?: boolean } };
    setRealExecAvailable(!!health.lanes?.realExecution);
    setDoctor(doctorResult);
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
      await Promise.all([loadTasks(project.id), loadDecisions(project.id)]);
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

  /** Manual replay fallback — folds `GET /events` into the reducers (de-duped). */
  async function refreshTranscript() {
    if (!conversationId) return;
    try {
      const replay = await client.events(conversationId, 0);
      setTranscript(foldEvents(emptyTranscript(), replay));
      setLanes(foldLaneEvents(emptyLanes(), replay));
    } catch (e) {
      reportError(e);
    }
  }

  async function startLane(): Promise<void> {
    if (!laneGoal.trim() || !conversationId || laneBusy) return;
    setLaneBusy(true);
    setError('');
    try {
      const budget: { maxTurns?: number; maxMinutes?: number } = {};
      const turns = Number.parseInt(laneMaxTurns, 10);
      const minutes = Number.parseInt(laneMaxMinutes, 10);
      if (Number.isFinite(turns) && turns > 0) budget.maxTurns = turns;
      if (Number.isFinite(minutes) && minutes > 0) budget.maxMinutes = minutes;
      await client.lanesStart({
        conversationId,
        goal: laneGoal.trim(),
        dryRun: laneDryRun,
        real: laneReal,
        detach: true, // observe via the live event stream
        ...(Object.keys(budget).length > 0 ? { budget } : {}),
      });
      setLaneGoal('');
    } catch (e) {
      reportError(e);
    } finally {
      setLaneBusy(false);
    }
  }

  async function cancelLane(laneId: string): Promise<void> {
    try {
      await client.lanesCancel(laneId);
    } catch (e) {
      reportError(e);
    }
  }

  async function loadTasks(projectId = selectedProject?.id) {
    if (!projectId) return;
    const result = await client.call('tasks.list', { projectId });
    setTasks(extractArray<Task>(result, ['tasks']));
  }

  async function loadDecisions(projectId = selectedProject?.id) {
    if (!projectId) return;
    setDecisions(await client.decisionsList({ projectId }));
  }

  // Knowledge writes go through the same typed events as every other surface;
  // each one needs the active project + conversation as provenance.
  function writeCtx(): { projectId: string; conversationId: string } | null {
    return selectedProject && conversationId
      ? { projectId: selectedProject.id, conversationId }
      : null;
  }

  async function addTask() {
    const ctx = writeCtx();
    if (!ctx || !taskDraft.trim()) return;
    try {
      await client.tasksCreate({ ...ctx, title: taskDraft.trim() });
      setTaskDraft('');
      await loadTasks();
    } catch (e) {
      reportError(e);
    }
  }

  async function completeTask(taskId: string) {
    const ctx = writeCtx();
    if (!ctx) return;
    try {
      await client.tasksComplete({ ...ctx, taskId });
      await loadTasks();
    } catch (e) {
      reportError(e);
    }
  }

  async function addDecision() {
    const ctx = writeCtx();
    if (!ctx || !decisionDraft.trim()) return;
    try {
      await client.decisionsRecord({ ...ctx, text: decisionDraft.trim() });
      setDecisionDraft('');
      await loadDecisions();
    } catch (e) {
      reportError(e);
    }
  }

  async function rememberMemory() {
    const ctx = writeCtx();
    if (!ctx || !rememberDraft.trim()) return;
    try {
      await client.memoryPut({ ...ctx, scope: 'project', content: rememberDraft.trim() });
      setRememberDraft('');
    } catch (e) {
      reportError(e);
    }
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
          <h2>Runtime</h2>
          {doctor ? (
            doctor.sections.map((s) => {
              const worst = s.checks.some((c) => c.status === 'fail')
                ? 'fail'
                : s.checks.some((c) => c.status === 'warn')
                  ? 'warn'
                  : 'ok';
              return (
                <div key={s.title} className="doctor-section">
                  <div className="doctor-head">
                    <strong>{s.title}</strong>
                    <span className={`doc-badge doc-${worst}`}>
                      {worst === 'ok' ? 'ok' : worst === 'warn' ? 'needs setup' : 'failing'}
                    </span>
                  </div>
                  {s.checks
                    .filter((c) => c.status !== 'ok')
                    .map((c) => (
                      <p key={c.id} className="doctor-detail">
                        {c.label}
                        {c.detail ? ` — ${c.detail}` : ''}
                      </p>
                    ))}
                </div>
              );
            })
          ) : (
            <p>Runtime checks not loaded yet.</p>
          )}
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
          {memory.length === 0 && memoryQuery ? <p className="empty-note">No matches.</p> : null}
          {memory.map((m) => (
            <p key={m.id} dir={textDir(m.content)}>
              {m.content}
            </p>
          ))}
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              void rememberMemory();
            }}
          >
            <input
              value={rememberDraft}
              onChange={(e) => setRememberDraft(e.target.value)}
              dir={textDir(rememberDraft)}
              placeholder="Remember for this project…"
            />
            <button type="submit" disabled={!rememberDraft.trim() || !conversationId}>
              Save
            </button>
          </form>
        </section>
        <section className="card">
          <h2>Tasks</h2>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              void addTask();
            }}
          >
            <input
              value={taskDraft}
              onChange={(e) => setTaskDraft(e.target.value)}
              dir={textDir(taskDraft)}
              placeholder="Add a task…"
            />
            <button type="submit" disabled={!taskDraft.trim() || !conversationId}>
              Add
            </button>
          </form>
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
                  <button
                    type="button"
                    className="task-complete"
                    onClick={() => completeTask(t.id)}
                  >
                    Done
                  </button>
                ) : null}
              </div>
            ))
          )}
        </section>
        <section className="card">
          <h2>Decisions</h2>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              void addDecision();
            }}
          >
            <input
              value={decisionDraft}
              onChange={(e) => setDecisionDraft(e.target.value)}
              dir={textDir(decisionDraft)}
              placeholder="Record a decision…"
            />
            <button type="submit" disabled={!decisionDraft.trim() || !conversationId}>
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
        <section className="card lanes-card">
          <h2>Lanes</h2>
          <form
            className="lane-form"
            onSubmit={(e) => {
              e.preventDefault();
              void startLane();
            }}
          >
            <textarea
              value={laneGoal}
              onChange={(e) => setLaneGoal(e.target.value)}
              dir={textDir(laneGoal)}
              placeholder="Lane goal (e.g. tidy the repo)"
              rows={2}
            />
            <div className="lane-budget">
              <input
                type="number"
                min="1"
                value={laneMaxTurns}
                onChange={(e) => setLaneMaxTurns(e.target.value)}
                placeholder="max turns"
              />
              <input
                type="number"
                min="1"
                value={laneMaxMinutes}
                onChange={(e) => setLaneMaxMinutes(e.target.value)}
                placeholder="max min"
              />
            </div>
            <label className="lane-check">
              <input
                type="checkbox"
                checked={laneDryRun}
                onChange={(e) => setLaneDryRun(e.target.checked)}
              />
              Dry run (record mandate only)
            </label>
            <label
              className="lane-check"
              title="Real execution must be enabled on the daemon (AMRITA_LANES_ALLOW_REAL_EXECUTION)."
            >
              <input
                type="checkbox"
                checked={laneReal}
                disabled={laneDryRun}
                onChange={(e) => setLaneReal(e.target.checked)}
              />
              Run for real {realExecAvailable ? '' : '(daemon opt-in required)'}
            </label>
            <button type="submit" disabled={laneBusy || !laneGoal.trim() || !conversationId}>
              {laneBusy ? '…' : 'Start lane'}
            </button>
          </form>
          <div className="lane-list">
            {laneViews.length === 0 ? (
              <p>No lanes yet.</p>
            ) : (
              laneViews.map((lane) => (
                <article key={lane.id} className={`lane lane-${lane.status}`}>
                  <div className="lane-head">
                    <span className={`lane-badge lane-badge-${lane.status}`}>{lane.status}</span>
                    <small>{lane.id.slice(0, 12)}</small>
                    {isActive(lane) ? (
                      <button
                        type="button"
                        className="lane-cancel"
                        onClick={() => void cancelLane(lane.id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                  {lane.goal ? (
                    <p className="lane-goal" dir={textDir(lane.goal)}>
                      {lane.goal}
                    </p>
                  ) : null}
                  {lane.progress.length > 0 ? (
                    <p className="lane-progress">{lane.progress.at(-1)?.note}</p>
                  ) : null}
                  {lane.exit ? (
                    <p className="lane-exit">
                      exit {lane.exit}
                      {lane.summary ? ` · ${lane.summary}` : lane.reason ? ` · ${lane.reason}` : ''}
                    </p>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </section>
      </aside>
    </main>
  );
}
