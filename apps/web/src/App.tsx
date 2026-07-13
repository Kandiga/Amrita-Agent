import { useEffect, useMemo, useRef, useState } from 'react';
import { type ActivityLine, currentActivity, pushActivity } from './activity.ts';
import {
  type AmritaEventLite,
  type CompanionState,
  type DecisionRowLite,
  type DoctorReportLite,
  type OperatorApprovalLite,
  type RoleResolutionLite,
  RpcError,
} from './api.ts';
import { clearToken, loadToken, maskToken, saveToken } from './auth.ts';
import { client } from './client.ts';
import { nextActions } from './companion.ts';
import { ApprovalsPanel } from './components/ApprovalsPanel.tsx';
import { BrainPanel } from './components/BrainPanel.tsx';
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
import { buildSandboxedPreview } from './sandbox.ts';
import { type EventStreamHandle, type StreamState, openEventStream } from './stream.ts';
import { buildSurfaceArtifacts } from './surface.ts';

type Project = { id: string; slug: string; name: string };
type Conversation = {
  id: string;
  projectId: string;
  title?: string | null;
  createdAt?: string;
  archivedAt?: string | null;
};
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

/** Center-stage views. Chat is not a stage — it lives in the right panel. */
type StageView = 'canvas' | 'project' | 'brain' | 'settings';
/** Mobile is single-pane: chat is a tab alongside the stage views. */
type MobileView = 'chat' | StageView;

const STREAM_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Offline',
  closed: 'Disconnected',
};

const STAGE_TABS: { id: Exclude<StageView, 'settings'>; label: string; hint: string }[] = [
  { id: 'canvas', label: 'Canvas', hint: 'everything Amrita builds, live' },
  { id: 'project', label: 'Project', hint: 'brief, tasks, decisions, lanes' },
  { id: 'brain', label: 'Brain', hint: 'the maintained knowledge harness' },
];

function extractArray<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of keys) if (Array.isArray(obj[key])) return obj[key] as T[];
  }
  return [];
}

/**
 * ADR-0039: the workspace canvas — loads the lane's real files from the daemon
 * by URL. Auth is a lane-scoped, expiring, READ-ONLY ticket in the path (never
 * the global bearer: frame content is lane-built and could read its own URL);
 * the ticket also flows to the page's relative subresources. Sandboxed:
 * scripts run, but with an opaque origin and a server CSP that forbids every
 * external channel. `refreshKey` remounts the frame as the lane writes.
 */
function WorkspaceFrame({
  laneId,
  title,
  ticket,
  refreshKey,
}: {
  laneId: string;
  title: string;
  ticket: string | null;
  refreshKey: number;
}) {
  if (!ticket) {
    return <div className="canvas-wait">Opening a read-only view of the workspace…</div>;
  }
  return (
    <iframe
      key={refreshKey}
      className="canvas-frame"
      title={title}
      sandbox="allow-scripts"
      src={`/lanes/${laneId}/workspace/t/${ticket}/`}
    />
  );
}

/** The live-canvas frame: same Stage-B sandbox as every preview (ADR-0020). */
function CanvasFrame({ html, title }: { html: string; title: string }) {
  const sandboxed = buildSandboxedPreview({
    kind: 'html-preview',
    id: 'canvas',
    projectId: 'canvas',
    title,
    html,
  });
  return (
    <iframe
      className="canvas-frame"
      title={title}
      sandbox={sandboxed.sandbox}
      srcDoc={sandboxed.srcDoc}
    />
  );
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
  const [provider, setProvider] = useState('auto');
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
  /** The center stage: live canvas (default), project board, brain, or settings. */
  const [stageView, setStageView] = useState<StageView>('canvas');
  /** Pending operator approvals (ADR-0021), refreshed from the live stream. */
  const [approvals, setApprovals] = useState<OperatorApprovalLite[]>([]);
  /** Live backstage feed (Hermes-style): what runs, waits, or thinks now. */
  const [activity, setActivity] = useState<readonly ActivityLine[]>([]);
  /** Optimistic project switch: the sidebar responds instantly, data follows. */
  const [projectLoading, setProjectLoading] = useState(false);
  /** The open live-canvas artifact id, or null (gallery). */
  const [canvasId, setCanvasId] = useState<string | null>(null);
  /** Lane-scoped workspace view tickets (ADR-0039 amendment), by laneId. */
  const [workspaceTickets, setWorkspaceTickets] = useState<Record<string, string>>({});
  /** ADR-0038 delete flow: which project is arming, and the typed slug. */
  const [deleteArm, setDeleteArm] = useState<string | null>(null);
  const [deleteDraft, setDeleteDraft] = useState('');
  /** Mobile: sidebar drawer + single-pane tab (Claude app pattern). */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>('chat');

  /** One switch drives both the mobile pane and the desktop stage. */
  function switchStage(view: StageView): void {
    setStageView(view);
    setMobileView(view);
    setSidebarOpen(false);
  }

  // The reducer is the single source of truth for the transcript; the stream and
  // any manual replay both feed it, de-duped by event id.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  // A 401/403 surfaces the Access section instead of a raw error line.
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
    setActivity([]);
    setPending([]);
    setStreamState('connecting');
    let handle: EventStreamHandle | null = null;
    handle = openEventStream(
      conversationId,
      {
        onEvent: (ev) => {
          setTranscript((s) => reduceEvent(s, ev));
          setLanes((s) => reduceLaneEvent(s, ev));
          setActivity((s) => pushActivity(s, ev));
          if (ev.type.startsWith('approval.')) void loadApprovals();
        },
        onState: (s) => setStreamState(s),
      },
      { sinceSeq: 0, ...(authToken ? { token: authToken } : {}) },
    );
    return () => handle?.close();
  }, [conversationId, authToken]);

  // The stage is live: when Amrita produces a NEW openable artifact mid-session,
  // the canvas opens on it by itself — the Screenshot-Brief "she builds, you watch"
  // behavior. Initial project load only primes the known set (no surprise jumps).
  const knownArtifactIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const openable = surfaceArtifacts.filter(
      (a) =>
        a.kind === 'html-preview' || a.kind === 'design-page' || a.kind === 'workspace-preview',
    );
    if (knownArtifactIds.current === null) {
      knownArtifactIds.current = new Set(openable.map((a) => a.id));
      return;
    }
    const fresh = openable.filter((a) => !knownArtifactIds.current?.has(a.id));
    for (const a of openable) knownArtifactIds.current.add(a.id);
    const newest = fresh[fresh.length - 1];
    if (newest && stageView === 'canvas') setCanvasId(newest.id);
  }, [surfaceArtifacts, stageView]);

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
    // Optimistic: the click responds NOW; data streams in behind the skeleton.
    setProjectSlug(slug);
    setProjectLoading(true);
    setConversations([]);
    setCanvasId(null);
    knownArtifactIds.current = null;
    setDeleteArm(null);
    setBusy(true);
    try {
      const ensured = (await client.call('project.ensure', {
        slug,
        name: slug === 'system' ? 'System' : slug,
      })) as { project?: Project } | Project;
      const project =
        'project' in ensured && ensured.project ? ensured.project : (ensured as Project);
      // A freshly ensured project (e.g. `system` on a brand-new DB) must join
      // the list immediately — selectedProject/writeCtx derive from it.
      setProjects((old) => (old.some((p) => p.id === project.id) ? old : [...old, project]));
      setProjectSlug(project.slug);
      const listResult = await client.call('conversation.list', { projectId: project.id });
      const list = extractArray<Conversation>(listResult, ['conversations']);
      setConversations(list);
      const firstLive = list.find((c) => !c.archivedAt);
      if (firstLive) openConversation(firstLive.id);
      else await createConversation(project.id);
      await Promise.all([
        loadTasks(project.id),
        loadDecisions(project.id),
        loadCompanion(project.id),
        loadApprovals(),
      ]);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
      setProjectLoading(false);
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

  /** End the session: compress it into the project's memory layers (ADR-0033)
   *  and continue in the lineage child. */
  async function compressSession(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const r = await client.call<{ childConversationId: string }>('conversation.compress', {
        conversationId: id,
      });
      const listResult = await client.call('conversation.list', {
        projectId: selectedProject?.id,
      });
      setConversations(extractArray<Conversation>(listResult, ['conversations']));
      openConversation(r.childConversationId);
      await loadCompanion(); // the digest just landed in project memory
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Shelve a session (ADR-0038): it leaves the sidebar; its history stays. */
  async function archiveSession(id: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await client.call('conversation.archive', { conversationId: id });
      const listResult = await client.call('conversation.list', {
        projectId: selectedProject?.id,
      });
      const list = extractArray<Conversation>(listResult, ['conversations']);
      setConversations(list);
      if (id === conversationId) {
        const nextLive = list.find((c) => !c.archivedAt);
        if (nextLive) openConversation(nextLive.id);
        else await createConversation();
      }
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
  }

  /** ADR-0038: the one destructive verb. Requires the typed slug to match. */
  async function deleteProject(p: Project): Promise<void> {
    if (busy || deleteDraft.trim() !== p.slug) return;
    setBusy(true);
    try {
      await client.call('project.delete', { projectId: p.id });
      setDeleteArm(null);
      setDeleteDraft('');
      const remaining = projects.filter((x) => x.id !== p.id);
      setProjects(remaining);
      const next = remaining.find((x) => x.slug === 'system') ?? remaining[0];
      await ensureProjectAndLoad(next?.slug ?? 'system');
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(false);
    }
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

  async function loadApprovals(): Promise<void> {
    try {
      setApprovals(await client.approvalsList());
    } catch (e) {
      reportError(e);
    }
  }

  async function resolveApproval(approvalId: string, decision: 'allow' | 'deny'): Promise<void> {
    try {
      await client.approvalsResolve({ approvalId, decision });
      await loadApprovals();
    } catch (e) {
      reportError(e);
    }
  }

  /** The open live-canvas artifact (Claude-Design style), re-derived live. */
  const canvasArtifact = useMemo(() => {
    const a = surfaceArtifacts.find((x) => x.id === canvasId);
    return a &&
      (a.kind === 'html-preview' || a.kind === 'design-page' || a.kind === 'workspace-preview')
      ? a
      : null;
  }, [surfaceArtifacts, canvasId]);

  // Mint the read-only view ticket when a workspace canvas opens (once per lane).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reportError is a stable module-level pattern here; tickets key on the lane.
  useEffect(() => {
    const a = canvasArtifact;
    if (!a || a.kind !== 'workspace-preview' || workspaceTickets[a.laneId]) return;
    client
      .call<{ ticket: string }>('lanes.workspace.ticket', { laneId: a.laneId })
      .then((r) => setWorkspaceTickets((old) => ({ ...old, [a.laneId]: r.ticket })))
      .catch((e) => reportError(e));
  }, [canvasArtifact, workspaceTickets]);

  /** The write envelope shared by every knowledge panel. */
  const writeCtx =
    selectedProject && conversationId ? { projectId: selectedProject.id, conversationId } : null;

  const pendingApprovals = useMemo(
    () => approvals.filter((a) => a.projectId === selectedProject?.id),
    [approvals, selectedProject],
  );

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
        // 'auto' = the role resolver decides (project > global binding > auto),
        // so the bound brain answers. An explicit pick still always wins.
        ...(provider === 'auto' ? { role: 'main' } : { provider }),
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

  /** The Access section (Settings): the ONLY place the token is managed. */
  const accessSection = (
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
      <p className="access-note">
        Stored only in this browser and sent as a bearer header — never written to the store or
        logs.
      </p>
    </section>
  );

  return (
    <main className={`app-shell mobile-${mobileView}`}>
      <button
        type="button"
        className={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`}
        aria-label="Close menu"
        onClick={() => setSidebarOpen(false)}
        tabIndex={sidebarOpen ? 0 : -1}
      />
      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="brand">
          <span className="mark">अ</span>
          <div>
            <strong>Amrita</strong>
            <small>project-aware agent OS</small>
          </div>
        </div>
        <section className="sidebar-projects">
          <h2>Projects</h2>
          <div className="list project-tree">
            {projects.map((p) => {
              const active = p.slug === projectSlug;
              const liveSessions = active ? conversations.filter((c) => !c.archivedAt) : [];
              const compressedCount = active ? conversations.length - liveSessions.length : 0;
              const arming = deleteArm === p.id;
              return (
                <div key={p.id} className={`project-node${active ? ' active' : ''}`}>
                  <div className="project-row">
                    <button
                      type="button"
                      className={active ? 'active' : ''}
                      onClick={() => {
                        if (!active) void ensureProjectAndLoad(p.slug);
                      }}
                    >
                      <span className="project-caret">{active ? '▾' : '▸'}</span>
                      {p.name}
                    </button>
                    {active && p.slug !== 'system' ? (
                      <button
                        type="button"
                        className="project-delete"
                        title="Delete this project and everything it owns"
                        aria-label={`Delete project ${p.name}`}
                        onClick={() => {
                          setDeleteArm(arming ? null : p.id);
                          setDeleteDraft('');
                        }}
                      >
                        🗑
                      </button>
                    ) : null}
                  </div>
                  {arming ? (
                    <div className="delete-confirm">
                      <p>
                        Deletes every session, memory, task and decision this project owns. This
                        cannot be undone. Type <code>{p.slug}</code> to confirm.
                      </p>
                      <input
                        type="text"
                        value={deleteDraft}
                        onChange={(e) => setDeleteDraft(e.target.value)}
                        placeholder={p.slug}
                        autoComplete="off"
                      />
                      <div className="delete-actions">
                        <button
                          type="button"
                          className="danger"
                          disabled={deleteDraft.trim() !== p.slug || busy}
                          onClick={() => void deleteProject(p)}
                        >
                          Delete forever
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteArm(null);
                            setDeleteDraft('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {active ? (
                    <div className="session-list">
                      {projectLoading ? (
                        <>
                          <span className="session-skeleton" />
                          <span className="session-skeleton" />
                        </>
                      ) : (
                        <>
                          {liveSessions.map((c) => (
                            <div
                              key={c.id}
                              className={`session-row${c.id === conversationId ? ' active' : ''}`}
                            >
                              <button
                                type="button"
                                className="session-open"
                                onClick={() => {
                                  setSidebarOpen(false);
                                  if (mobileView !== 'chat') setMobileView('chat');
                                  openConversation(c.id);
                                }}
                              >
                                {titleFor(c)}
                              </button>
                              {c.id === conversationId ? (
                                <button
                                  type="button"
                                  className="session-compress"
                                  title="End this session — compress it into the project's memory layers and continue in a fresh linked session"
                                  onClick={() => void compressSession(c.id)}
                                  disabled={busy}
                                >
                                  ⤓
                                </button>
                              ) : null}
                              <button
                                type="button"
                                className="session-archive"
                                title="Archive this session — it leaves the list; its history stays in the project"
                                aria-label={`Archive session ${titleFor(c)}`}
                                onClick={() => void archiveSession(c.id)}
                                disabled={busy}
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            className="session-new"
                            onClick={() => void createConversation()}
                            disabled={busy}
                          >
                            + New session
                          </button>
                          {compressedCount > 0 ? (
                            <small className="session-archived-note">
                              {compressedCount} compressed or archived in project memory
                            </small>
                          ) : null}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
        <div className="sidebar-footer">
          <button
            type="button"
            className={`sidebar-settings${stageView === 'settings' ? ' active' : ''}`}
            onClick={() => switchStage('settings')}
          >
            <span className="gear">⚙</span>
            Settings
            <span
              className={`token-dot ${authToken ? 'ok' : 'warn'}`}
              title={authToken ? 'access token set' : 'no access token'}
            />
          </button>
        </div>
      </aside>

      <section className="stage">
        <header className="stage-head">
          <button
            type="button"
            className="hamburger"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <nav className="stage-tabs" aria-label="Workspace views">
            {STAGE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={stageView === t.id ? 'active' : ''}
                title={t.hint}
                onClick={() => switchStage(t.id)}
              >
                {t.label}
              </button>
            ))}
            {stageView === 'settings' ? (
              <span className="stage-crumb" aria-current="page">
                Settings
              </span>
            ) : null}
          </nav>
          <button
            type="button"
            className="stage-refresh"
            onClick={() => void refreshBase().then(() => ensureProjectAndLoad(projectSlug))}
            disabled={busy}
            title="Reload projects and this project's state"
          >
            Refresh
          </button>
        </header>

        <div className="stage-body">
          {stageView === 'settings' ? (
            <div className="settings-page">
              <h1 className="settings-title">Settings</h1>
              <SettingsRuntimeHub
                key={authToken ?? 'no-token'}
                projectId={selectedProject?.id}
                projectName={selectedProject?.name}
                writeCtx={writeCtx}
                onTasksChanged={() => void loadTasks()}
                onError={reportError}
                accessSlot={accessSection}
                focusAccess={unauthorized}
              />
            </div>
          ) : stageView === 'brain' ? (
            <div className="stage-brain">
              <BrainPanel
                projectId={selectedProject?.id}
                writeCtx={writeCtx}
                onError={reportError}
              />
            </div>
          ) : stageView === 'project' ? (
            <div className="stage-project">
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
            </div>
          ) : canvasArtifact ? (
            <section className="canvas-panel" aria-label="Live canvas">
              <header className="canvas-head">
                <span className="artifact-kind">
                  {canvasArtifact.kind === 'workspace-preview'
                    ? 'live build'
                    : canvasArtifact.kind === 'design-page'
                      ? 'design'
                      : 'preview'}
                </span>
                <strong dir="auto">{canvasArtifact.title}</strong>
                <span
                  className={`doc-badge preview-${
                    canvasArtifact.kind === 'workspace-preview'
                      ? canvasArtifact.laneStatus
                      : canvasArtifact.status
                  }`}
                >
                  {canvasArtifact.kind === 'workspace-preview'
                    ? canvasArtifact.laneStatus
                    : canvasArtifact.status}
                </span>
                <div className="canvas-actions">
                  {canvasArtifact.kind !== 'workspace-preview' &&
                  canvasArtifact.status === 'proposed' ? (
                    <button
                      type="button"
                      className="canvas-approve"
                      onClick={() =>
                        void approvePreview(canvasArtifact.id, canvasArtifact.contentHash)
                      }
                    >
                      Approve
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="canvas-close"
                    aria-label="Back to the gallery"
                    onClick={() => setCanvasId(null)}
                  >
                    ✕
                  </button>
                </div>
              </header>
              {canvasArtifact.kind === 'workspace-preview' ? (
                <WorkspaceFrame
                  laneId={canvasArtifact.laneId}
                  title={canvasArtifact.title}
                  ticket={workspaceTickets[canvasArtifact.laneId] ?? null}
                  refreshKey={Math.floor(canvasArtifact.rev / 4)}
                />
              ) : (
                <CanvasFrame html={canvasArtifact.html} title={canvasArtifact.title} />
              )}
              <p className="canvas-live-note">
                {canvasArtifact.kind === 'workspace-preview'
                  ? 'Live build — real files the lane is writing in its workspace, refreshed as it works; scripts run inside the sandbox only.'
                  : "Live canvas — re-renders from this project's typed state (brief · brand · milestones); confined to the zero-network sandbox."}
              </p>
            </section>
          ) : (
            <div className="stage-gallery">
              {surfaceArtifacts.length === 0 ? (
                <div className="stage-empty">
                  <span>अ</span>
                  <h1>The live canvas</h1>
                  <p>
                    Everything Amrita builds shows up here while she works — briefs, boards, pages,
                    previews. Ask for something in the chat and watch it land.
                  </p>
                </div>
              ) : (
                <SurfacePanel
                  artifacts={surfaceArtifacts}
                  onApprovePreview={approvePreview}
                  onOpenCanvas={(id) => setCanvasId(id)}
                />
              )}
            </div>
          )}
        </div>
      </section>

      <section className="chat-panel">
        <header className="topbar">
          <button
            type="button"
            className="hamburger"
            aria-label="Open menu"
            onClick={() => setSidebarOpen(true)}
          >
            ☰
          </button>
          <div className="topbar-title">
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
                <option value="auto">auto — your bound brain</option>
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
                Every project keeps its own memory, tasks and decisions. Say what you need — what
                she builds appears on the canvas, live.
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
          {busy ? (
            <article className="bubble agent thinking" aria-label="Amrita is working">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
            </article>
          ) : null}
        </div>
        {(() => {
          const now = currentActivity(activity, busy);
          return activity.length > 0 || now ? (
            <details className="activity-bar">
              <summary>
                <span className={`activity-now activity-${now?.tone ?? 'info'}`}>
                  {now ? now.text : 'idle — full backstage log'}
                </span>
                <small>{activity.length} events</small>
              </summary>
              <div className="activity-log" dir="ltr">
                {[...activity].reverse().map((l) => (
                  <p key={l.id} className={`activity-line activity-${l.tone}`}>
                    <span className="activity-ts">{l.ts ? l.ts.slice(11, 19) : ''}</span>
                    {l.text}
                  </p>
                ))}
              </div>
            </details>
          ) : null;
        })()}
        {pendingApprovals.length > 0 ? (
          <div className="chat-approvals">
            <ApprovalsPanel
              approvals={pendingApprovals}
              onResolve={(id, d) => void resolveApproval(id, d)}
            />
          </div>
        ) : null}
        {lastTurn ? <div className="turn-meta">{lastTurn}</div> : null}
        {unauthorized ? (
          <div className="error" role="alert">
            Unauthorized — set a valid access token in{' '}
            <button type="button" className="error-link" onClick={() => switchStage('settings')}>
              Settings → Access
            </button>{' '}
            to reach the runtime.
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
            onKeyDown={(e) => {
              // claude.ai behavior: Enter sends, Shift+Enter breaks the line
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            dir={textDir(draft)}
            placeholder="Message Amrita…"
            rows={2}
          />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send message">
            {busy ? '…' : '↑'}
          </button>
        </form>
      </section>

      <nav className="mobile-tabs" aria-label="Sections">
        {(
          [
            ['chat', 'Chat'],
            ['canvas', 'Canvas'],
            ['project', 'Project'],
            ['brain', 'Brain'],
          ] as const
        ).map(([view, label]) => (
          <button
            type="button"
            key={view}
            className={mobileView === view ? 'active' : ''}
            onClick={() => {
              if (view === 'chat') setMobileView('chat');
              else switchStage(view);
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </main>
  );
}
