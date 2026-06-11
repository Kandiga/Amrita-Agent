import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AmritaEventLite,
  type CompanionState,
  type DecisionRowLite,
  type DoctorReportLite,
  type RoleResolutionLite,
  RpcError,
} from './api.ts';
import { clearToken, loadToken, maskToken, saveToken } from './auth.ts';
import { client } from './client.ts';
import { nextActions } from './companion.ts';
import { BrandPanel } from './components/BrandPanel.tsx';
import { BriefPanel } from './components/BriefPanel.tsx';
import { DecisionsPanel } from './components/DecisionsPanel.tsx';
import { LanesPanel } from './components/LanesPanel.tsx';
import { MemoryPanel } from './components/MemoryPanel.tsx';
import { MilestonesPanel } from './components/MilestonesPanel.tsx';
import { NextActionsPanel } from './components/NextActionsPanel.tsx';
import { RuntimePanel } from './components/RuntimePanel.tsx';
import { SettingsRuntimeHub } from './components/SettingsRuntimeHub.tsx';
import { QuestionsPanel, RisksPanel } from './components/SettleListPanel.tsx';
import { SurfacePanel } from './components/SurfacePanel.tsx';
import { TasksPanel } from './components/TasksPanel.tsx';
import { TimelinePanel } from './components/TimelinePanel.tsx';
import {
  type LanesState,
  emptyLanes,
  foldLaneEvents,
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
import { buildSurfaceArtifacts } from './surface.ts';

type Project = { id: string; slug: string; name: string };
type Conversation = { id: string; projectId: string; title?: string | null; createdAt?: string };
type Provider = {
  id: string;
  available?: boolean;
  configuredAccounts?: number;
  envReady?: boolean;
  streaming?: boolean;
};
type Task = { id: string; title: string; status?: string; milestoneId?: string | null };
type ChatResult = {
  conversationId: string;
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
};

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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authToken, setAuthToken] = useState<string | undefined>(() => loadToken());
  const [tokenDraft, setTokenDraft] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [lanes, setLanes] = useState<LanesState>(emptyLanes());
  const [realExecAvailable, setRealExecAvailable] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReportLite | null>(null);
  const [decisions, setDecisions] = useState<DecisionRowLite[]>([]);
  // ── project companion (ADR-0018/0020) ──
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [timeline, setTimeline] = useState<AmritaEventLite[]>([]);
  /** Effective fast/main/deep model resolution for the open project (§2.8). */
  const [roleInfo, setRoleInfo] = useState<RoleResolutionLite[]>([]);
  /** Inspector mode: the Project Brain panels, or the Settings & Runtime Hub. */
  const [showSettings, setShowSettings] = useState(false);

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

  // Stage-A native surface: deterministic artifacts derived from typed state
  // (docs/strategy/native-interactive-surface.md). Empty project = empty surface.
  const surfaceArtifacts = useMemo(
    () =>
      selectedProject
        ? buildSurfaceArtifacts({
            projectId: selectedProject.id,
            brief: companion?.brief ?? null,
            brand: companion?.brand ?? null,
            milestones: companion?.milestones ?? [],
            tasks,
            lanes: laneViews,
            previewApprovals: companion?.previewApprovals ?? [],
          })
        : [],
    [selectedProject, companion, tasks, laneViews],
  );

  // Rule-based next-best actions over typed state — never an LLM guess.
  const companionActions = useMemo(
    () =>
      nextActions({
        doctor,
        brief: companion?.brief ?? null,
        questions: companion?.questions ?? [],
        risks: companion?.risks ?? [],
        milestones: companion?.milestones ?? [],
        tasks,
        decisions,
        lanes: laneViews,
        conversationId,
      }),
    [doctor, companion, tasks, decisions, laneViews, conversationId],
  );

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
      client.call<DoctorReportLite>('doctor'),
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
      await Promise.all([
        loadTasks(project.id),
        loadDecisions(project.id),
        loadCompanion(project.id),
      ]);
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

  async function loadTasks(projectId = selectedProject?.id) {
    if (!projectId) return;
    const result = await client.call('tasks.list', { projectId });
    setTasks(extractArray<Task>(result, ['tasks']));
  }

  async function loadDecisions(projectId = selectedProject?.id) {
    if (!projectId) return;
    setDecisions(await client.decisionsList({ projectId }));
  }

  /** Load the Project Brain aggregate, activity timeline, and model resolution. */
  async function loadCompanion(projectId = selectedProject?.id) {
    if (!projectId) return;
    const [state, events, roles] = await Promise.all([
      client.companionGet(projectId),
      client.timelineList(projectId, 30),
      client.providersRoles(projectId),
    ]);
    setCompanion(state);
    setTimeline(events);
    setRoleInfo(roles.roles);
  }

  /** The write envelope shared by every knowledge panel. */
  const writeCtx =
    selectedProject && conversationId ? { projectId: selectedProject.id, conversationId } : null;

  /** Durably approve a proposed preview's exact content (ADR-0020). */
  async function approvePreview(previewId: string, contentHash: string): Promise<void> {
    if (!writeCtx) return;
    try {
      await client.previewApprove({ ...writeCtx, previewId, contentHash });
      await loadCompanion();
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
            <small>project-aware agent OS</small>
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
              {(() => {
                const open = conversations.find((c) => c.id === conversationId);
                return open ? titleFor(open) : 'ready';
              })()}
            </small>
          </div>
          <div className="topbar-controls">
            <button
              type="button"
              className={showSettings ? 'settings-toggle active' : 'settings-toggle'}
              onClick={() => setShowSettings((v) => !v)}
              title="Runtime settings — models, providers, coding runtimes"
            >
              {showSettings ? 'Project' : 'Settings'}
            </button>
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
              <p>
                Every project keeps its own memory, tasks and decisions. Say what you need — replies
                stream in live, and lanes can take on the bigger jobs.
              </p>
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
        {showSettings ? (
          <SettingsRuntimeHub
            projectId={selectedProject?.id}
            projectName={selectedProject?.name}
            onError={reportError}
          />
        ) : (
          <>
            <NextActionsPanel actions={companionActions} />
            <BriefPanel
              brief={companion?.brief ?? null}
              writeCtx={writeCtx}
              onChanged={() => void loadCompanion()}
              onError={reportError}
            />
            <BrandPanel
              brand={companion?.brand ?? null}
              writeCtx={writeCtx}
              onChanged={() => void loadCompanion()}
              onError={reportError}
            />
            <SurfacePanel artifacts={surfaceArtifacts} onApprovePreview={approvePreview} />
            <RuntimePanel doctor={doctor} />
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
              <p>
                {selectedProvider?.streaming
                  ? 'streams replies live (model.delta)'
                  : 'replies arrive whole — live streaming for this provider is not built yet'}
              </p>
              {roleInfo.length > 0 ? (
                <p className="role-line">
                  {roleInfo
                    .map(
                      (r) =>
                        `${r.role} → ${r.resolvesTo}${r.model ? ` (${r.model})` : ''}${
                          r.via === 'project' ? ' [project]' : r.via === 'auto' ? ' [auto]' : ''
                        }`,
                    )
                    .join(' · ')}
                </p>
              ) : null}
            </section>
            <MemoryPanel
              projectId={selectedProject?.id}
              writeCtx={writeCtx}
              onError={reportError}
            />
            <TasksPanel
              tasks={tasks}
              milestones={companion?.milestones ?? []}
              writeCtx={writeCtx}
              onChanged={() => void loadTasks()}
              onError={reportError}
            />
            <MilestonesPanel
              milestones={companion?.milestones ?? []}
              tasks={tasks}
              writeCtx={writeCtx}
              onChanged={() => void loadCompanion()}
              onError={reportError}
            />
            <QuestionsPanel
              items={companion?.questions ?? []}
              writeCtx={writeCtx}
              onChanged={() => void loadCompanion()}
              onError={reportError}
            />
            <RisksPanel
              items={companion?.risks ?? []}
              writeCtx={writeCtx}
              onChanged={() => void loadCompanion()}
              onError={reportError}
            />
            <DecisionsPanel
              decisions={decisions}
              writeCtx={writeCtx}
              onChanged={() => void loadDecisions()}
              onError={reportError}
            />
            <LanesPanel
              lanes={laneViews}
              conversationId={conversationId}
              realExecAvailable={realExecAvailable}
              onError={reportError}
            />
            <TimelinePanel events={timeline} />
          </>
        )}
      </aside>
    </main>
  );
}
