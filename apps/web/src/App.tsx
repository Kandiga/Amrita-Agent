import {
  type CharterStatusWire,
  type ChatFocus,
  type InboxItemRowWire,
  type PhaseRowWire,
  type TaskRowWire,
  isProjectDomainEvent,
} from '@amrita/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type ActivityLine, currentActivity, pushActivity } from './activity.ts';
import { extractAgentArtifacts, extractStreamingArtifact } from './agent-canvas.ts';
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
import {
  type CapsuleState,
  capsuleHasContent,
  emptyCapsule,
  hydrateCapsule,
  resetCapsuleFor,
} from './capsule-state.ts';
import { client } from './client.ts';
import { nextActions } from './companion.ts';
import { ActivationPanel } from './components/ActivationPanel.tsx';
import { ApprovalsPanel } from './components/ApprovalsPanel.tsx';
import { BoardPanel } from './components/BoardPanel.tsx';
import { BrainPanel } from './components/BrainPanel.tsx';
import { BrandPanel } from './components/BrandPanel.tsx';
import { BriefPanel } from './components/BriefPanel.tsx';
import { CanvasFrame } from './components/CanvasFrame.tsx';
import { CapsulePanel } from './components/CapsulePanel.tsx';
import { CinemaPanel } from './components/CinemaPanel.tsx';
import { ClaudeEcosystemPanel } from './components/ClaudeEcosystemPanel.tsx';
import { DecisionsPanel } from './components/DecisionsPanel.tsx';
import { FreeCanvas, type FreeCanvasArtifact } from './components/FreeCanvas.tsx';
import { HubPanel } from './components/HubPanel.tsx';
import { InboxPanel } from './components/InboxPanel.tsx';
import { LanesPanel } from './components/LanesPanel.tsx';
import { MemoryPanel } from './components/MemoryPanel.tsx';
import { MilestonesPanel } from './components/MilestonesPanel.tsx';
import { MissionControlPanel } from './components/MissionControlPanel.tsx';
import { NextActionsPanel } from './components/NextActionsPanel.tsx';
import { PhasesPanel } from './components/PhasesPanel.tsx';
import { RetroPanel } from './components/RetroPanel.tsx';
import { ReviewPanel } from './components/ReviewPanel.tsx';
import { RuntimePanel } from './components/RuntimePanel.tsx';
import { SessionsPanel } from './components/SessionsPanel.tsx';
import { SettingsRuntimeHub } from './components/SettingsRuntimeHub.tsx';
import { QuestionsPanel, RisksPanel } from './components/SettleListPanel.tsx';
import { StatusStrip } from './components/StatusStrip.tsx';
import { SurfacePanel } from './components/SurfacePanel.tsx';
import { TasksPanel } from './components/TasksPanel.tsx';
import { TimelinePanel } from './components/TimelinePanel.tsx';
import { WorkspacePanel } from './components/WorkspacePanel.tsx';
import {
  type LanesState,
  emptyLanes,
  foldLaneEvents,
  lanesList,
  mergeLanesFromRows,
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
import { buildMissionRows } from './mission-control.ts';
import { buildSandboxedPreview } from './sandbox.ts';
import {
  type SessionPanes,
  emptySessions,
  hydrateSessionSnapshot,
  reduceSessionPane,
} from './session-state.ts';
import { type EventStreamHandle, type StreamState, openEventStream } from './stream.ts';
import { buildSurfaceArtifacts } from './surface.ts';

type Project = {
  id: string;
  slug: string;
  name: string;
  activatedAt?: string | null;
  root?: string | null;
};
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
/** The board reads real task rows (ADR-0044), not a hand-rolled subset. */
type Task = TaskRowWire;
type ChatResult = {
  conversationId: string;
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number } | null;
};

/** Center-stage views. Chat is not a stage — it lives in the right panel. */
type StageView = 'canvas' | 'project' | 'brain' | 'claude' | 'codex' | 'settings';
/** Mobile is single-pane: chat is a tab alongside the stage views. */
type MobileView = 'chat' | StageView;

const STREAM_LABELS: Record<StreamState, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  error: 'Offline',
  closed: 'Disconnected',
};

/** Board / List / Timeline are three PROJECTIONS of the same rows (ADR-0044). */
type ProjectView = 'board' | 'list' | 'timeline';
const PROJECT_VIEWS: { id: ProjectView; label: string }[] = [
  { id: 'board', label: 'Board' },
  { id: 'list', label: 'List' },
  { id: 'timeline', label: 'Timeline' },
];

const STAGE_TABS: { id: Exclude<StageView, 'settings'>; label: string; hint: string }[] = [
  { id: 'canvas', label: 'Canvas', hint: 'everything Amrita builds, live' },
  { id: 'project', label: 'Project', hint: 'brief, tasks, decisions, lanes' },
  { id: 'brain', label: 'Brain', hint: 'the maintained knowledge harness' },
  { id: 'claude', label: 'Claude', hint: 'live Claude Code sessions (ADR-0049)' },
  { id: 'codex', label: 'Codex', hint: 'live Codex sessions (ADR-0049)' },
];

const SESSION_PROJECTION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'lane.spawned',
  'lane.completed',
  'lane.aborted',
  'approval.requested',
  'approval.resolved',
  'approval.timed_out',
]);

function shouldRefreshSessions(type: string): boolean {
  return SESSION_PROJECTION_EVENT_TYPES.has(type);
}

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

function titleFor(c: Conversation): string {
  return c.title || `Conversation ${c.id.slice(0, 8)}`;
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [newProjectName, setNewProjectName] = useState<string | null>(null);
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
  const [sessions, setSessions] = useState<SessionPanes>(emptySessions());
  const [realExecAvailable, setRealExecAvailable] = useState(false);
  const [doctor, setDoctor] = useState<DoctorReportLite | null>(null);
  const [decisions, setDecisions] = useState<DecisionRowLite[]>([]);
  /** The Inbox — pending proposals awaiting triage (ADR-0044). */
  const [inbox, setInbox] = useState<InboxItemRowWire[]>([]);
  const [capture, setCapture] = useState('');
  /** Mobile: quick-capture is collapsed behind a “＋” toggle so the bottom of the
   *  screen is just the composer — capture opens on demand (mobile UX pass). */
  const [captureOpen, setCaptureOpen] = useState(false);
  /** The computed charter critique (ADR-0045). */
  const [charter, setCharter] = useState<CharterStatusWire | null>(null);
  /** The project's own phases — the board's columns (ADR-0045). */
  const [phases, setPhases] = useState<PhaseRowWire[]>([]);
  /**
   * What the operator has open (ADR-0045). Sent with the next chat turn so the
   * conversation is about the thing on screen: "אם פתחת סיכון, היא יודעת שאתה
   * מדבר על הסיכון."
   */
  const [focus, setFocus] = useState<ChatFocus | null>(null);
  // ── project companion (ADR-0018/0020) ──
  const [companion, setCompanion] = useState<CompanionState | null>(null);
  const [timeline, setTimeline] = useState<AmritaEventLite[]>([]);
  /** Effective fast/main/deep model resolution for the open project (§2.8). */
  const [roleInfo, setRoleInfo] = useState<RoleResolutionLite[]>([]);
  /** The center stage: live canvas (default), project board, brain, or settings. */
  const [stageView, setStageView] = useState<StageView>('canvas');
  /** Which projection of the task rows the Project stage is showing. */
  const [projectView, setProjectView] = useState<ProjectView>('board');
  /**
   * Today, as YYYY-MM-DD. Read ONCE here and passed down, so the board module
   * itself stays clock-free (and therefore deterministic and testable).
   */
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  /** Pending operator approvals (ADR-0021), refreshed from the live stream. */
  const [approvals, setApprovals] = useState<OperatorApprovalLite[]>([]);
  /** The derived Conclusion Capsule for the open conversation (ADR-0048 §11). */
  const [capsuleState, setCapsuleState] = useState<CapsuleState>(emptyCapsule);
  /** Live backstage feed (Hermes-style): what runs, waits, or thinks now. */
  const [activity, setActivity] = useState<readonly ActivityLine[]>([]);
  /** Optimistic project switch: the sidebar responds instantly, data follows. */
  const [projectLoading, setProjectLoading] = useState(false);
  /** The open live-canvas artifact id, or null (gallery). */
  const [canvasId, setCanvasId] = useState<string | null>(null);
  /** The selected free-canvas build card — the next instruction targets it (Phase 3). */
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  /** A throttled copy of the streaming draft — the live-build card re-renders from
   *  this so it updates in smooth ~300ms chunks, not on every token (flicker). */
  const [previewDraft, setPreviewDraft] = useState('');
  const previewThrottle = useRef<{ last: number; timer: ReturnType<typeof setTimeout> | null }>({
    last: 0,
    timer: null,
  });
  /** Lane-scoped workspace view tickets (ADR-0039 amendment), by laneId. */
  const [workspaceTickets, setWorkspaceTickets] = useState<Record<string, string>>({});
  /** The Claude Ecosystem drawer (ADR-0043) — quiet launcher, opens on demand. */
  const [ecoOpen, setEcoOpen] = useState(false);
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
  // The conversation/project the UI is CURRENTLY on. Async handlers capture these
  // at call time and compare against the live value before writing state, so a
  // reply or a load that finishes after the user switched away is dropped instead
  // of corrupting the new view (stability audit: cross-conversation fold, switch race).
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const loadSeq = useRef(0);
  /** Orders overlapping project-session hydrations within the same project. */
  const sessionLoadSeq = useRef(0);

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
  /** Stable id for the stream effect: the socket must not churn on every render. */
  const streamProjectId = selectedProject?.id;
  const projectIdRef = useRef(streamProjectId);
  projectIdRef.current = streamProjectId;
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
  const surfaceArtifacts = useMemo(() => {
    if (!selectedProject) return [];
    const base = buildSurfaceArtifacts({
      projectId: selectedProject.id,
      brief: companion?.brief ?? null,
      brand: companion?.brand ?? null,
      milestones: companion?.milestones ?? [],
      tasks,
      lanes: laneViews,
      previewApprovals: companion?.previewApprovals ?? [],
    });
    // CANVAS-1: HTML the agent builds in chat becomes a live canvas artifact, so
    // "ask for something and watch it land" actually works.
    const built = extractAgentArtifacts(messages, selectedProject.id);
    return [...base, ...built];
  }, [selectedProject, companion, tasks, laneViews, messages]);

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
    const streamConversationId = conversationId;
    const isCurrentStream = () =>
      conversationIdRef.current === streamConversationId &&
      projectIdRef.current === streamProjectId;
    setTranscript(emptyTranscript());
    setActivity([]);
    setPending([]);
    setStreamState('connecting');
    let handle: EventStreamHandle | null = null;
    handle = openEventStream(
      conversationId,
      {
        onEvent: (ev) => {
          if (!isCurrentStream()) return;
          setTranscript((s) => reduceEvent(s, ev));
          setLanes((s) => reduceLaneEvent(s, ev));
          setSessions((s) => reduceSessionPane(s, ev)); // same-conversation live pane
          setActivity((s) => pushActivity(s, ev));
          // ADR-0044/0050: durable project projections are refetched after a
          // conversation-local change; raw pane/progress output is never part of that fetch.
          if (isProjectDomainEvent(ev.type)) {
            if (streamProjectId && shouldRefreshSessions(ev.type)) {
              void loadProjectSessions(streamProjectId);
            }
            void refreshProject();
          }
        },
        // A domain change ELSEWHERE in this project (another tab, the CLI,
        // Telegram). No cursor — it is a notification, so we refetch (ADR-0044/0050).
        onProjectEvent: (ev) => {
          if (!isCurrentStream()) return;
          if (streamProjectId && shouldRefreshSessions(ev.type)) {
            void loadProjectSessions(streamProjectId);
          }
          void refreshProject();
        },
        // Pane output from another conversation in this project is explicitly
        // isolated from the transcript cursor and folded only into Session Workspace.
        onProjectSessionEvent: (ev) => {
          if (isCurrentStream()) setSessions((s) => reduceSessionPane(s, ev));
        },
        onState: (s) => {
          if (!isCurrentStream()) return;
          setStreamState(s);
          if (s === 'open' && streamProjectId) {
            void loadProjectSessions(streamProjectId);
          }
        },
      },
      {
        sinceSeq: 0,
        ...(streamProjectId ? { projectId: streamProjectId } : {}),
        ...(authToken ? { token: authToken } : {}),
      },
    );
    return () => handle?.close();
  }, [conversationId, authToken, streamProjectId]);

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
    // project.list is the AUTH probe: a 401 here must propagate so the caller shows
    // the token screen. The diagnostics below are best-effort — a failing doctor or
    // health probe must not blank the projects tree (it used to be all-or-nothing).
    const projectResult = await client.call('project.list');
    const [providerResult, healthResult, doctorResult] = await Promise.allSettled([
      client.call('providers.list'),
      client.call('health'),
      client.call<DoctorReportLite>('doctor'),
    ]);
    const nextProjects = extractArray<Project>(projectResult, ['projects']);
    setProjects(nextProjects);
    setUnauthorized(false); // a successful project.list means the token is accepted
    if (providerResult.status === 'fulfilled')
      setProviders(extractArray<Provider>(providerResult.value, ['providers']));
    if (healthResult.status === 'fulfilled') {
      const health = healthResult.value as { lanes?: { realExecution?: boolean } };
      setRealExecAvailable(!!health.lanes?.realExecution);
    }
    if (doctorResult.status === 'fulfilled') setDoctor(doctorResult.value as DoctorReportLite);
    if (nextProjects.length > 0 && !nextProjects.some((p) => p.slug === projectSlug))
      setProjectSlug(nextProjects[0]?.slug ?? 'system');
  }

  async function loadProjectSessions(projectId = selectedProject?.id): Promise<void> {
    if (!projectId) return;
    sessionLoadSeq.current += 1;
    const myLoad = sessionLoadSeq.current;
    const current = () => projectIdRef.current === projectId && sessionLoadSeq.current === myLoad;
    try {
      const rows = await client.lanesList({ projectId });
      if (!current()) return;
      setLanes((live) => mergeLanesFromRows(live, rows));

      // Durable lane rows recover membership/lifecycle; tmux remains the screen SSOT.
      // Terminal lanes need no capture because their runtime state comes from the row.
      const activeInteractive = rows.filter(
        (row) =>
          row.kind.endsWith('-tmux') &&
          (row.status === 'spawned' || row.status === 'running' || row.status === 'merging'),
      );
      const settled = await Promise.allSettled(
        activeInteractive.map((row) => client.sessionSnapshot(projectId, row.id)),
      );
      if (!current()) return;
      setSessions((currentSessions) => {
        let next = currentSessions;
        for (const result of settled) {
          if (result.status === 'fulfilled') next = hydrateSessionSnapshot(next, result.value);
        }
        return next;
      });
    } catch (e) {
      if (current()) reportError(e);
    }
  }

  async function ensureProjectAndLoad(slug: string) {
    // A monotonic token: if the operator clicks a second project while this one is
    // still loading, the older call's late setStates are dropped, so two concurrent
    // loads cannot interleave and flip the UI back to the wrong project.
    loadSeq.current += 1;
    const myLoad = loadSeq.current;
    const current = () => loadSeq.current === myLoad;
    sessionLoadSeq.current += 1;
    if (refreshTimer.current) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
    // Optimistic: the click responds NOW; data streams in behind the skeleton.
    setProjectSlug(slug);
    setProjectLoading(true);
    setConversations([]);
    projectIdRef.current = undefined;
    setLanes(emptyLanes());
    setSessions(emptySessions());
    setCanvasId(null);
    knownArtifactIds.current = null;
    setDeleteArm(null);
    // A selection belongs to the project you made it in — never let it ride into
    // another project's chat.turn (its ids resolve against the new project and
    // render nothing, but the app state would be lying about what you're discussing).
    setFocus(null);
    setBusy(true);
    try {
      const ensured = (await client.call('project.ensure', {
        slug,
        name: slug === 'system' ? 'System' : slug,
      })) as { project?: Project } | Project;
      if (!current()) return;
      const project =
        'project' in ensured && ensured.project ? ensured.project : (ensured as Project);
      // A freshly ensured project (e.g. `system` on a brand-new DB) must join
      // the list immediately — selectedProject/writeCtx derive from it.
      setProjects((old) => (old.some((p) => p.id === project.id) ? old : [...old, project]));
      projectIdRef.current = project.id;
      setProjectSlug(project.slug);
      const listResult = await client.call('conversation.list', { projectId: project.id });
      if (!current()) return;
      const list = extractArray<Conversation>(listResult, ['conversations']);
      setConversations(list);
      const firstLive = list.find((c) => !c.archivedAt);
      if (firstLive) openConversation(firstLive.id);
      else await createConversation(project.id);
      await Promise.all([
        loadTasks(project.id),
        loadDecisions(project.id),
        loadCompanion(project.id),
        loadInbox(project.id),
        loadApprovals(),
        loadProjectSessions(project.id),
      ]);
    } catch (e) {
      if (current()) reportError(e);
    } finally {
      if (current()) {
        setBusy(false);
        setProjectLoading(false);
      }
    }
  }

  /**
   * Create a NEW named project from the app. ensureProjectAndLoad already does the
   * full create+select via project.ensure; the only thing missing was an entry
   * point — without it a fresh DB is stuck on the reserved `system` project.
   * The slug is derived from the name (lowercased, spaces→dashes) so the operator
   * only types a human name.
   */
  async function createProject(): Promise<void> {
    const name = (newProjectName ?? '').trim();
    if (!name) return;
    const slug =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || `project-${Date.now()}`;
    setNewProjectName(null);
    await ensureProjectAndLoad(slug);
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
    // A card selection is scoped to the session it was made in; drop it on switch.
    setFocus(null);
    setConversationId(id);
    // Clear the capsule immediately so a stale one never lingers over the new
    // conversation, then fetch this one's (ADR-0048 §11).
    setCapsuleState(resetCapsuleFor(id));
    void loadCapsule(id);
  }

  /**
   * Fetch the derived Conclusion Capsule for a conversation (ADR-0048 §11) and
   * fold it in only if that conversation is still selected — a slow response for
   * a past conversation can never paint over the current one. Read-only: it is
   * never appended as a message or event.
   */
  async function loadCapsule(id: string): Promise<void> {
    if (!id) {
      setCapsuleState(resetCapsuleFor(null));
      return;
    }
    try {
      const capsule = await client.conclusionCapsule(id);
      setCapsuleState((s) => hydrateCapsule(s, capsule, id, conversationIdRef.current));
    } catch {
      // The capsule is a supervisory nicety; a failed fetch simply shows nothing.
    }
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
    const requestedConversationId = conversationId;
    try {
      const replay = await client.events(requestedConversationId, 0);
      if (conversationIdRef.current !== requestedConversationId) return;
      setTranscript(foldEvents(emptyTranscript(), replay));
      await loadProjectSessions();
      if (conversationIdRef.current !== requestedConversationId) return;
      setLanes((current) => foldLaneEvents(current, replay));
    } catch (e) {
      if (conversationIdRef.current === requestedConversationId) reportError(e);
    }
  }

  // These are fired un-awaited from the debounced refreshProject; a transient
  // failure must surface as a banner (and keep the last-known projection), never
  // an unhandled rejection.
  async function loadTasks(projectId = selectedProject?.id) {
    if (!projectId) return;
    try {
      const result = await client.call('tasks.list', { projectId });
      if (projectIdRef.current !== projectId) return;
      setTasks(extractArray<Task>(result, ['tasks']));
    } catch (e) {
      if (projectIdRef.current === projectId) reportError(e);
    }
  }

  async function loadDecisions(projectId = selectedProject?.id) {
    if (!projectId) return;
    try {
      const next = await client.decisionsList({ projectId });
      if (projectIdRef.current !== projectId) return;
      setDecisions(next);
    } catch (e) {
      if (projectIdRef.current === projectId) reportError(e);
    }
  }

  async function loadInbox(projectId = selectedProject?.id) {
    if (!projectId) return;
    try {
      const next = await client.inboxList({ projectId, status: 'pending' });
      if (projectIdRef.current !== projectId) return;
      setInbox(next);
    } catch (e) {
      if (projectIdRef.current === projectId) reportError(e);
    }
  }

  /**
   * Refetch durable project projections after a domain change (ADR-0044).
   * Session snapshots are intentionally refreshed separately and only for lane /
   * approval lifecycle events: pane capture must not join every task event burst.
   *
   * Debounced, because one turn can land a burst of events (the Scribe files
   * several proposals at once) and each of them would otherwise trigger a full
   * reload. A refetch is idempotent, so coalescing them is always safe.
   */
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function refreshProject(): void {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      void loadTasks();
      void loadInbox();
      void loadCompanion(); // also reloads the charter status and the phases
      void loadDecisions();
      void loadApprovals();
      // The capsule derives from lane/inbox/approval/task lifecycle, so it moves
      // with the same project-event burst (ADR-0048 §11).
      void loadCapsule(conversationIdRef.current);
    }, 120);
  }

  /** Quick capture → the Inbox. Never straight into project truth (ADR-0044). */
  async function captureToInbox(): Promise<void> {
    const text = capture.trim();
    if (!text || !writeCtx) return;
    setCapture('');
    try {
      await client.inboxCapture({ ...writeCtx, text });
      await loadInbox();
    } catch (e) {
      setCapture(text); // give the operator their words back
      reportError(e);
    }
  }

  /** Load the Project Brain aggregate, activity timeline, and model resolution. */
  async function loadCompanion(projectId = selectedProject?.id) {
    if (!projectId) return;
    try {
      const [state, events, roles, charterStatus, phaseList] = await Promise.all([
        client.companionGet(projectId),
        client.timelineList(projectId, 30),
        client.providersRoles(projectId),
        client.charterStatus(projectId),
        client.phasesList(projectId),
      ]);
      if (projectIdRef.current !== projectId) return;
      setCompanion(state);
      setTimeline(events);
      setRoleInfo(roles.roles);
      setCharter(charterStatus);
      setPhases(phaseList);
    } catch (e) {
      if (projectIdRef.current === projectId) reportError(e);
    }
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

  // Every HTML build becomes a movable card on the free canvas (Live Canvas). A
  // multi-page site or several variations produce several cards at once. The
  // in-progress build (streaming) is a live "building…" card, prepended so the
  // operator watches it take shape before Amrita finishes (Phase 2).
  const buildCards: FreeCanvasArtifact[] = useMemo(() => {
    const done = surfaceArtifacts
      .filter(
        (a): a is Extract<typeof a, { kind: 'html-preview' | 'design-page' }> =>
          a.kind === 'html-preview' || a.kind === 'design-page',
      )
      .map((a) => ({
        id: a.id,
        title: a.title,
        kindLabel: a.kind === 'design-page' ? 'design' : 'build',
        html: a.html,
      }));
    // If a build is SELECTED and being improved, the streaming preview carries the
    // selected card's id — so it rebuilds IN PLACE (same card) rather than opening
    // a new one. Otherwise it is a fresh "building…" card.
    const focusLabel = focus?.kind === 'artifact' ? focus.label : undefined;
    const streaming = extractStreamingArtifact(previewDraft, focusLabel);
    if (!streaming) return done;
    const card: FreeCanvasArtifact = {
      id: streaming.id,
      title: streaming.title,
      kindLabel: 'build',
      html: streaming.html,
      building: true,
    };
    const idx = done.findIndex((c) => c.id === streaming.id);
    if (idx >= 0) {
      const next = [...done];
      next[idx] = card; // improving THIS build → replace its content in place
      return next;
    }
    return [card, ...done]; // a brand-new build → its own card
  }, [surfaceArtifacts, previewDraft, focus]);

  // Throttle the streaming draft into `previewDraft` so the live-build card
  // re-renders in ~300ms chunks (watch the layers appear), not on every token.
  // When the turn finishes (draft cleared), drop the preview immediately.
  useEffect(() => {
    const d = transcript.draft ?? '';
    const st = previewThrottle.current;
    if (!d) {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      setPreviewDraft('');
      return;
    }
    const THROTTLE = 300;
    const now = Date.now();
    const wait = Math.max(0, THROTTLE - (now - st.last));
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.last = Date.now();
      st.timer = null;
      setPreviewDraft(d);
    }, wait);
    return () => {
      if (st.timer) clearTimeout(st.timer);
    };
  }, [transcript.draft]);

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
    const optimisticId = `local-${Date.now()}`;
    const optimistic: ChatMessage = { id: optimisticId, role: 'user', text };
    setPending((old) => [...old, optimistic]);
    try {
      const result = await client.call<ChatResult>('chat.turn', {
        text,
        conversationId,
        // 'auto' = the role resolver decides (project > global binding > auto),
        // so the bound brain answers. An explicit pick still always wins.
        ...(provider === 'auto' ? { role: 'main' } : { provider }),
        ...(focus ? { focus } : {}),
      });
      setLastTurn(`${result.provider} · ${result.model} · ${formatUsage(result.usage)}`);
      // Fallback replay: if the live socket is offline, this still lands the turn;
      // when it is live, the reducer de-dupes the overlap by event id.
      const replay = await client.events(result.conversationId, transcriptRef.current.lastSeq);
      // Guard against a switch mid-await: if the operator moved to another
      // conversation, folding THIS conversation's events into the now-different
      // transcript would corrupt it. Drop the result — the new conversation loads
      // its own history, and this turn is safely in the store either way.
      if (conversationIdRef.current !== result.conversationId) return;
      setTranscript((s) => foldEvents(s, replay));
      // On success the echoed user message is in `replay`; prune the optimistic
      // twin so `pending` does not grow unbounded across a session.
      setPending((old) => old.filter((m) => m.id !== optimisticId));
    } catch (e) {
      // The turn never committed: no `message.user` event exists, so the optimistic
      // bubble would otherwise linger forever, looking sent. Roll it back and give
      // the operator their words back — exactly the quick-capture restore pattern.
      setPending((old) => old.filter((m) => m.id !== optimisticId));
      setDraft((d) => (d ? d : text));
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
          <div className="sidebar-projects-head">
            <h2>Projects</h2>
            <button
              type="button"
              className="new-project-btn"
              title="Create a new project"
              aria-label="Create a new project"
              onClick={() => setNewProjectName((v) => (v === null ? '' : null))}
            >
              +
            </button>
          </div>
          {newProjectName !== null ? (
            <form
              className="new-project-form"
              onSubmit={(e) => {
                e.preventDefault();
                void createProject();
              }}
            >
              <input
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                dir={textDir(newProjectName)}
                placeholder="Project name…"
                aria-label="New project name"
                // biome-ignore lint/a11y/noAutofocus: the field only exists once the operator opens it
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNewProjectName(null);
                }}
              />
              <button type="submit" disabled={!newProjectName.trim()}>
                Create
              </button>
            </form>
          ) : null}
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
          ) : stageView === 'claude' || stageView === 'codex' ? (
            <div className="stage-sessions">
              <SessionsPanel
                agent={stageView === 'claude' ? 'claude' : 'codex'}
                lanes={laneViews}
                projectId={selectedProject?.id ?? ''}
                conversationId={conversationId ?? ''}
                sessions={sessions}
                approvals={pendingApprovals}
                realExecAvailable={realExecAvailable}
                authToken={authToken}
                onChanged={async () => {
                  await Promise.all([loadProjectSessions(), loadApprovals()]);
                }}
                onError={reportError}
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
            /* The project control room (ADR-0044). The charter states what this
               project is for; the Inbox is where new truth arrives; the board /
               list / timeline are three PROJECTIONS of the same rows, so they can
               never disagree. Runtime and brand are real but secondary — they sit
               behind a disclosure rather than shouting from an 11-card grid. */
            <div className="project-room">
              {/* Four indicators that change a decision — not twenty numbers (ADR-0045). */}
              <StatusStrip
                activated={!!selectedProject?.activatedAt}
                tasks={tasks}
                milestones={companion?.milestones ?? []}
                risks={companion?.risks ?? []}
                today={today}
              />
              <NextActionsPanel actions={companionActions} />
              <BriefPanel
                brief={companion?.brief ?? null}
                charter={charter}
                writeCtx={writeCtx}
                onChanged={() => void loadCompanion()}
                onError={reportError}
              />
              <InboxPanel
                items={inbox}
                writeCtx={writeCtx}
                onChanged={refreshProject}
                onError={reportError}
              />
              <ReviewPanel
                projectId={selectedProject?.id}
                onRaised={refreshProject}
                onError={reportError}
              />

              {/* Not a plan yet? Then no empty board — a proposal, or a nudge back
                  to the conversation (ADR-0045). */}
              <ActivationPanel
                charter={charter}
                activatedAt={selectedProject?.activatedAt ?? null}
                writeCtx={writeCtx}
                onActivated={() => {
                  void refreshBase();
                  refreshProject();
                }}
                onError={reportError}
              />

              <nav className="project-views" aria-label="Project view">
                {PROJECT_VIEWS.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={projectView === v.id ? 'active' : ''}
                    aria-pressed={projectView === v.id}
                    onClick={() => setProjectView(v.id)}
                  >
                    {v.label}
                  </button>
                ))}
              </nav>

              <MissionControlPanel rows={buildMissionRows(tasks, lanes.byId, approvals)} />

              {projectView === 'board' ? (
                <BoardPanel
                  tasks={tasks}
                  phases={phases}
                  writeCtx={writeCtx}
                  today={today}
                  focusedIds={focus?.kind === 'task' ? focus.ids : []}
                  onFocus={(ids) => setFocus(ids.length > 0 ? { kind: 'task', ids } : null)}
                  onChanged={refreshProject}
                  onError={reportError}
                />
              ) : projectView === 'timeline' ? (
                <TimelinePanel events={timeline} />
              ) : (
                <div className="project-cards">
                  <TasksPanel
                    tasks={tasks}
                    milestones={companion?.milestones ?? []}
                    writeCtx={writeCtx}
                    onChanged={refreshProject}
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
                </div>
              )}

              {/* The two doors out of the project: one to strangers, one to the next
                  project. Both are hand-operated, and both say what they cost. */}
              <div className="project-cards">
                <HubPanel
                  projectId={selectedProject?.id}
                  writeCtx={writeCtx}
                  onError={reportError}
                />
                <RetroPanel
                  projectId={selectedProject?.id}
                  writeCtx={writeCtx}
                  onError={reportError}
                />
              </div>

              <details className="project-more">
                <summary>Runtime, brand and delegated lanes</summary>
                <div className="project-cards">
                  <WorkspacePanel
                    projectId={selectedProject?.id}
                    root={selectedProject?.root ?? null}
                    writeCtx={writeCtx}
                    onChanged={() => void refreshBase()}
                    onError={reportError}
                  />
                  <PhasesPanel
                    phases={phases}
                    writeCtx={writeCtx}
                    onChanged={refreshProject}
                    onError={reportError}
                  />
                  <CinemaPanel conversationId={conversationId} onError={reportError} />
                  <LanesPanel
                    lanes={laneViews}
                    conversationId={conversationId}
                    realExecAvailable={realExecAvailable}
                    onError={reportError}
                  />
                  <BrandPanel
                    brand={companion?.brand ?? null}
                    writeCtx={writeCtx}
                    onChanged={() => void loadCompanion()}
                    onError={reportError}
                  />
                  <MemoryPanel
                    projectId={selectedProject?.id}
                    writeCtx={writeCtx}
                    onError={reportError}
                  />
                  <RuntimePanel doctor={doctor} />
                  <section className="card">
                    <h2>Provider status</h2>
                    <div className="provider-row">
                      <strong>{selectedProvider?.id ?? provider}</strong>
                      <span>
                        {selectedProvider?.available === false ? 'unavailable' : 'available'}
                      </span>
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
                                r.via === 'project'
                                  ? ' [project]'
                                  : r.via === 'auto'
                                    ? ' [auto]'
                                    : ''
                              }`,
                          )
                          .join(' · ')}
                      </p>
                    ) : null}
                  </section>
                </div>
              </details>
            </div>
          ) : buildCards.length > 0 ? (
            <FreeCanvas
              conversationId={conversationId}
              artifacts={buildCards}
              selectedId={selectedArtifactId}
              onSelect={(id, title) => {
                // Select a build → the next instruction is about THAT build (ADR-0047).
                setSelectedArtifactId(id);
                setFocus({ kind: 'artifact', ids: [], label: title });
              }}
            />
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
                  : canvasArtifact.id.startsWith('agent-html:')
                    ? 'Built by Amrita in this chat — running live inside the zero-network sandbox (no filesystem, no network).'
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
        {capsuleState.capsule && capsuleHasContent(capsuleState.capsule) ? (
          <CapsulePanel capsule={capsuleState.capsule} />
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
        {/* One tidy toolbar above the composer (mobile): a compact quick-capture
            toggle + the live-session chip, so the bottom of the screen is calm and
            the composer is the clear place to type. On desktop the capture field
            stays inline. Quick capture goes to the Inbox, never project truth. */}
        <div className="chat-toolbar">
          <form
            className={`quick-capture${captureOpen ? ' open' : ''}`}
            onSubmit={(e) => {
              e.preventDefault();
              void captureToInbox();
              setCaptureOpen(false);
            }}
          >
            <button
              type="button"
              className="capture-toggle"
              onClick={() => setCaptureOpen((v) => !v)}
              aria-expanded={captureOpen}
              aria-label="Quick capture to the Inbox"
              title="Quick capture → Inbox"
            >
              <span aria-hidden="true">＋</span>
              <span className="capture-toggle-label">Capture</span>
            </button>
            <input
              value={capture}
              onChange={(e) => setCapture(e.target.value)}
              dir={textDir(capture)}
              placeholder="Quick capture → Inbox"
              aria-label="Quick capture to the Inbox"
              disabled={!writeCtx}
            />
            <button
              type="submit"
              className="capture-submit"
              disabled={!writeCtx || !capture.trim()}
            >
              Capture
            </button>
          </form>
          <button
            type="button"
            className={`eco-launcher${ecoOpen ? ' active' : ''}`}
            onClick={() => setEcoOpen((v) => !v)}
            aria-expanded={ecoOpen}
            title="What Claude Code actually has right now — runtime, tools, skills, MCP, live session"
          >
            <span
              className={`eco-launcher-dot ${laneViews.some((l) => !l.exit) ? 'live' : 'idle'}`}
            />
            <span className="eco-launcher-text">
              Claude session
              {laneViews.some((l) => !l.exit) ? <em>· running</em> : null}
            </span>
          </button>
        </div>
        <ClaudeEcosystemPanel
          open={ecoOpen}
          onClose={() => setEcoOpen(false)}
          projectId={selectedProject?.id}
          lanes={laneViews}
          onError={reportError}
        />
        {focus && (focus.kind === 'artifact' ? !!focus.label : focus.ids.length > 0) && (
          <div className="focus-chip">
            <span>
              {focus.kind === 'artifact'
                ? `Talking about “${focus.label}”`
                : `Talking about ${focus.ids.length} ${focus.kind}${focus.ids.length === 1 ? '' : 's'}`}
            </span>
            <button
              type="button"
              onClick={() => {
                setFocus(null);
                setSelectedArtifactId(null);
              }}
              aria-label="Stop focusing on the selection"
            >
              ✕
            </button>
          </div>
        )}
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
          <button
            type="submit"
            disabled={busy || !draft.trim() || !conversationId}
            aria-label="Send message"
          >
            {busy ? '…' : '↑'}
          </button>
        </form>
      </section>

      {/* Mobile: a pending approval is time-limited (deny-by-default) and must be
          answerable from ANY view — a session on the Claude/Codex tab can't be
          approved from the chat column you can't see. This sticky bar surfaces the
          oldest pending approval above the bottom nav, everywhere, on mobile. */}
      {pendingApprovals.length > 0 && pendingApprovals[0] ? (
        <div className="mobile-approval-bar" role="alertdialog" aria-label="Approval needed">
          <div className="mobile-approval-text">
            <strong>Approval needed</strong>
            <span dir={textDir(pendingApprovals[0].detail ?? pendingApprovals[0].action)}>
              {pendingApprovals[0].action}
              {pendingApprovals.length > 1 ? ` · +${pendingApprovals.length - 1} more` : ''}
            </span>
          </div>
          <div className="mobile-approval-actions">
            <button
              type="button"
              className="allow"
              onClick={() => void resolveApproval(pendingApprovals[0]?.approvalId ?? '', 'allow')}
            >
              Allow
            </button>
            <button
              type="button"
              className="deny"
              onClick={() => void resolveApproval(pendingApprovals[0]?.approvalId ?? '', 'deny')}
            >
              Deny
            </button>
          </div>
        </div>
      ) : null}

      <nav className="mobile-tabs" aria-label="Sections">
        {(
          [
            ['chat', 'Chat'],
            ['canvas', 'Canvas'],
            ['project', 'Project'],
            ['brain', 'Brain'],
            // Mobile parity: the live coding sessions are reachable on the phone too.
            ['claude', 'Claude'],
            ['codex', 'Codex'],
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
