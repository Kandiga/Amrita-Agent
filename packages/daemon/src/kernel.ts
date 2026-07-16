import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ClaudeCodeLaneRunner,
  CodexLaneRunner,
  type LaneRunner,
  ResearchLaneRunner,
  SESSION_GOAL_SENT_PROGRESS,
  type TmuxController,
  TmuxSessionLaneRunner,
  classifyBootPane,
  createNodeTmuxController,
  redactPane,
} from '@amrita/lanes';
import {
  type AmritaEvent,
  type ChatFocus,
  type CinemaMandate,
  type CinemaMandateReport,
  type ConclusionCapsule,
  type ConnectorStatusReport,
  type ConversationRow,
  type HarnessTopology,
  type KnowledgeSource,
  type LaneExit,
  type MergeReport,
  type ProjectBrain,
  type ProjectContextWire,
  type ProjectRow,
  type SessionRuntimeState,
  type SessionSnapshotWire,
  type SkillStatus,
  type UnsealedEvent,
  cinemaMandateReportSchema,
  cinemaMandateSchema,
  laneMandateSchema,
  mergeReportSchema,
  newId,
  parseEvent,
} from '@amrita/protocol';
import {
  type AccountRow,
  type AuthMode,
  type Certainty,
  type ChannelLink,
  type ConnectorRow,
  type ConversationNode,
  type DecisionRight,
  type DecisionRow,
  type Derivation,
  type EntityWriteOpts,
  type InboxConfidence,
  type InboxItemRow,
  type InboxKind,
  type InboxOrigin,
  type InboxStatus,
  type LaneRow,
  type LaneStatus,
  type MemoryEntryRow,
  type MemoryScope,
  type MilestoneRow,
  type MilestoneStatus,
  type OpenQuestionRow,
  type PairingRow,
  type PhaseRow,
  type PreviewApprovalRow,
  type ProjectBrandRow,
  type ProjectBriefRow,
  type ProjectConstraint,
  type ProviderConfigStatus,
  type QuestionStatus,
  type RiskRow,
  type RiskSeverity,
  type Store,
  type TaskPriority,
  type TaskRow,
  type TaskStatus,
  openStore,
} from '@amrita/store';
import { resolveAgent } from './agent-select.ts';
import { type CharterFinding, auditCharter, readyToActivate } from './charter-audit.ts';
import {
  completeCinemaMandate,
  issueCinemaMandate,
  listCinemaMandates,
} from './cinema-mandates.ts';
import { type CapsuleLane, buildConclusionCapsule } from './conclusion-capsule.ts';
import { connectorStatuses } from './connectors.ts';
import {
  AMRITA_CAPABILITIES,
  AMRITA_ORCHESTRATOR,
  CONTEXT_PACK_SETTING,
  ORCHESTRATION_SETTING,
  type SessionBrief,
  buildProjectContextPack,
} from './context-pack.ts';
import { probeGitContext, rootExists, summarizeFiles } from './context.ts';
import {
  type RouteVerdict,
  classifyIntent,
  classifyRelay,
  looksLikeBuildIntent,
  routeFor,
} from './execution-route.ts';
import { fetchGithubIssues } from './github.ts';
import {
  HARNESS_TOPOLOGY,
  baseKnowledgeSources,
  buildProjectBrain,
  cinemaKnowledgeSource,
} from './harness.ts';
import { type PublicHub, SLUG_RE, buildPublicHub, contentHash, renderPublicHub } from './hub.ts';
import { resolveApprovalPolicy } from './lane-approval.ts';
import { activeScopeConflicts } from './lane-scope.ts';
import { buildMandateFromChat } from './mandate-synth.ts';
import {
  type ChatMessage,
  type ChatProvider,
  type ChatUsage,
  type CliExec,
  type FetchLike,
  LOCAL_ENDPOINT_SETTING,
  MOCK_PROVIDER_ID,
  MockProvider,
  type ModelDiscovery,
  type ProviderCatalogEntry,
  ProviderError,
  type ProviderInfo,
  type ProviderRole,
  REAL_PROVIDERS,
  type RealProviderSpec,
  type RoleBinding,
  defaultFetch,
  envPresent,
  findProviderSpec,
  killAllCliExec,
  normalizeProvider,
  parseLocalEndpoint,
  parseRoleBinding,
  probeOpenAiModels,
  readEnvSecret,
  roleSettingKey,
  suggestV1BaseUrl,
} from './provider.ts';
import {
  ORG_MEMORY_SOURCE_PREFIX,
  type RetroPacket,
  buildRetroPacket,
  renderRetroPacket,
} from './retro.ts';
import { type ReviewPacket, buildReviewPacket, renderReviewPacket } from './review.ts';
import {
  type CodingRuntimeStatus,
  type CommandProber,
  getClaudeCodeStatus,
  getRuntimesStatus,
} from './runtimes.ts';
import { SCHEDULER_STATE_SETTING } from './scheduler.ts';
import type { SchedulerStatus } from './scheduler.ts';
import {
  MAX_AUTO_QUESTIONS_PER_TURN,
  MAX_OPEN_QUESTIONS,
  SCRIBE_AUTO_OPEN_QUESTIONS_SETTING,
  SCRIBE_SETTING,
  buildScribePrompt,
  looksLikeProjectTruth,
  parseScribeResponse,
  questionKey,
  suggestedPayload,
} from './scribe.ts';
import { loadSkillStatuses } from './skills.ts';
import { clean } from './util.ts';

/** A chat turn request. */
export interface ChatTurnInput {
  conversationId: string;
  text: string;
  provider?: string;
  model?: string;
  /** What the operator has open on screen (ADR-0045) — the chat is about THAT. */
  focus?: ChatFocus;
  /**
   * A provider ROLE instead of a concrete provider (D5/ADR-0017). Resolution:
   * an explicit `provider` always wins; otherwise the role's settings binding
   * (`providers.role.<role>`); otherwise `auto` — the first available real
   * provider, else the deterministic mock. Never silently a broken provider.
   */
  role?: ProviderRole;
  /** Request a real provider account — currently returns a safe "not implemented" error. */
  accountId?: string;
  /** Record the user message and stop before invoking the provider. */
  dryRun?: boolean;
  channel?: EntityWriteOpts['channel'];
}

/** The result of a chat turn. Secret-free by construction. */
export interface ChatTurnResult {
  turnId: string;
  provider: string;
  model: string;
  /** The role this turn ran under (`main` when none was requested). */
  role: ProviderRole;
  userMessageId: string;
  userEvent: AmritaEvent;
  dryRun: boolean;
  assistantMessageId: string | null;
  assistantEvent: AmritaEvent | null;
  text: string | null;
  finishReason: string | null;
  usage: ChatUsage | null;
}

/** What `amritad` reports for `health`. Contains no secrets. */
export interface KernelHealth {
  ok: true;
  name: 'amritad';
  startedAt: string;
  dbPath: string;
  schemaVersion: number;
  counts: { projects: number; conversations: number; messages: number; events: number };
  /** Lane execution posture (no secrets) — `realExecution` is the opt-in gate. */
  lanes: { realExecution: boolean; active: number };
}

export interface KernelOptions {
  /** SQLite path, or ':memory:'. */
  dbPath: string;
  spillDir?: string;
  /** Injectable fetch for real provider adapters (tests pass a fake; defaults to global fetch). */
  fetchImpl?: FetchLike;
  /** Injectable lane runner (tests pass a fake; defaults to a safe, exec-disabled Claude Code runner). */
  laneRunner?: LaneRunner;
  /** Additional kind-dispatched runners (ADR-0023); override the built-ins by kind. */
  extraLaneRunners?: LaneRunner[];
  /** Injectable tmux boundary shared by runners and session-control RPCs (ADR-0050). */
  tmuxController?: TmuxController;
  /** Opt-in to REAL Claude Code lane execution. Default false (also `AMRITA_LANES_ALLOW_REAL_EXECUTION=1`). */
  allowRealLaneExecution?: boolean;
  /** Workspace roots a real lane's cwd must resolve within (also `AMRITA_LANES_ALLOWED_ROOTS`, `:`-sep). */
  laneAllowedRoots?: string[];
  /** Claude Code tools a REAL lane may use (also `AMRITA_LANES_ALLOWED_TOOLS`,
   * comma-sep). Unset = the runner's safe read-only default. */
  laneAllowedTools?: string[];
  /** Injectable coding-runtime prober (tests pass a fake; defaults to bounded spawn). */
  codingRuntimeProber?: CommandProber;
  /** Injectable CLI exec for subscription providers (tests pass a fake; defaults to bounded spawnSync). */
  cliExec?: CliExec;
  /** How long a pending approval waits before timing out to DENY (ADR-0021). */
  approvalTimeoutMs?: number;
}

/** A pending operator approval (kernel-runtime state; the audit trail is events). */
export interface PendingApproval {
  approvalId: string;
  action: string;
  detail?: string;
  projectId: string;
  conversationId: string;
  laneId?: string;
  requestedAt: string;
}

/** Start a lane (delegated unit of work). Secret-free; nested fields are zod-validated upstream. */
/**
 * What an Inbox item may be promoted INTO (ADR-0044). A discriminated union, so
 * the compiler — not a runtime string check — guarantees every branch supplies
 * exactly the fields its target command needs. Every arm maps to a command that
 * already existed; triage adds no new way to write the domain.
 */
export type TriageTarget =
  | { kind: 'task'; title: string; body?: string; milestoneId?: string }
  | { kind: 'decision'; text: string }
  | { kind: 'risk'; text: string; severity?: RiskSeverity }
  | { kind: 'question'; text: string }
  | { kind: 'milestone'; title: string; description?: string; targetDate?: string }
  | { kind: 'memory'; content: string };

export interface LaneStartInput {
  conversationId: string;
  goal: string;
  kind?: string;
  scope?: unknown;
  budget?: unknown;
  contextPack?: unknown;
  approvals?: 'forward' | 'auto-safe' | 'sandboxed';
  deliverables?: string[];
  /** Record `lane.spawned`/`lane.mandate` and stop before running the lane. */
  dryRun?: boolean;
  /** Explicit intent to run for real; on a non-opted-in daemon this fails safely. */
  real?: boolean;
  /** Return immediately with status `running`; the lane runs in the background. */
  detach?: boolean;
}

export interface LaneStartResult {
  laneId: string;
  status: LaneStatus;
  dryRun: boolean;
  detached: boolean;
  report: MergeReport | null;
  error?: string;
}

export interface LaneCancelResult {
  laneId: string;
  cancelled: boolean;
  status: LaneStatus | null;
}

/** The internal settle outcome of a background lane run. */
interface LaneSettleResult {
  status: LaneStatus;
  report: MergeReport | null;
  error?: string;
}

/** Catalog probes run at a human moment (the chooser) — give the CLI real time. */
const CATALOG_PROBE_TIMEOUT_MS = 10_000;

/** Deterministic compression digest (ADR-0033): counts + span + last messages. */
export function buildCompressionDigest(
  title: string | null,
  messages: { role: string; text: string; createdAt: string }[],
): string {
  const users = messages.filter((m) => m.role === 'user').length;
  const agents = messages.filter((m) => m.role === 'agent').length;
  const first = messages[0];
  const last = messages[messages.length - 1];
  const lines = [
    `Compressed continuation of "${title ?? 'conversation'}" — ${messages.length} messages ` +
      `(${users} user / ${agents} agent) between ${first?.createdAt ?? '?'} and ${last?.createdAt ?? '?'}.`,
    'Recent context:',
    ...messages.slice(-5).map((m) => {
      const text = m.text.length > 200 ? `${m.text.slice(0, 200)}…` : m.text;
      return `- [${m.role}] ${text.replace(/\s+/g, ' ')}`;
    }),
  ];
  return lines.join('\n').slice(0, 4000);
}

/** Parse a `:`-separated list of workspace roots (e.g. `AMRITA_LANES_ALLOWED_ROOTS`). */
function parseAllowedRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The Amrita kernel: owns the Store and exposes lifecycle + Store-API delegation.
 * It does NOT call model providers, run tools, or execute lanes (WO#2.1 scope) —
 * it is a deterministic application-services layer over the event-sourced store.
 * Everything goes through the Store API; the kernel never writes SQL itself.
 */
export class AmritaKernel {
  readonly store: Store;
  readonly dbPath: string;
  readonly startedAt: string;
  /** Whether REAL Claude Code lane execution is enabled on this daemon (opt-in). */
  readonly realLaneExecution: boolean;
  private readonly mock = new MockProvider();
  private readonly fetchImpl: FetchLike;
  /** Serves `claude-code` and whatever kind the injected default declares (tests: `fake`). */
  private readonly defaultLaneRunner: LaneRunner;
  /** ADR-0039: real lanes without explicit paths get `<root>/<laneId>`. */
  private readonly laneWorkspacesRoot: string | null;
  /** ADR-0043: the configured claude-code lane tool allowlist, surfaced read-only
   *  on `runtime.status` (tool NAMES only — never re-parses the env var). */
  private readonly laneAllowedTools: string[];
  /** Lane-scoped, expiring, read-only workspace view tickets (ADR-0039 amendment).
   *  Worthless outside `GET /lanes/<id>/workspace` — never accepted by RPC/events. */
  private readonly workspaceTickets = new Map<string, { ticket: string; expiresAt: number }>();
  /** Additional runners dispatched by lane kind (ADR-0023), e.g. `research`. */
  private readonly extraLaneRunners: Map<string, LaneRunner>;
  private readonly codingRuntimeProber: CommandProber | undefined;
  private readonly cliExec: CliExec | undefined;
  private readonly activeLanes = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<LaneSettleResult>;
      /** A durable (tmux) session outlives the daemon — close() must NOT abort it. */
      durable?: boolean;
      /** Graceful finish for an interactive session (ADR-0049), vs `controller` = cancel. */
      finishController?: AbortController;
    }
  >();
  /** Cached durable evidence that an interactive session already received its initial goal. */
  private readonly sessionGoalSentLanes = new Set<string>();
  /** Listeners for STREAM-ONLY events (model.delta, lane.pane) — never persisted (D8). */
  private readonly streamListeners = new Set<(ev: AmritaEvent) => void>();
  /** tmux boundary shared by interactive runners and control/snapshot RPCs (ADR-0050). */
  private readonly tmux: TmuxController;
  /**
   * Short-TTL cache for the coding-runtime status. The auth probe spawns
   * `claude auth status` / `codex` (~4s each), and the Planner + router ask for it on
   * EVERY build turn — so without a cache a few rapid build requests fan out into many
   * concurrent claude processes that race on the subscription's token refresh and fail
   * transiently ("unauthenticated"). Runtime auth barely changes; 30s is plenty.
   */
  private runtimesCache: { at: number; value: CodingRuntimeStatus[] } | null = null;
  /** Pending operator approvals (ADR-0021). Audit trail lives in approval.* events. */
  private readonly pendingApprovals = new Map<
    string,
    { info: PendingApproval; settle: (d: 'allow' | 'deny' | 'timeout') => void }
  >();
  private readonly approvalTimeoutMs: number;
  /** Channel runners the composition root has actually started (e.g. 'telegram'). */
  private readonly activeChannelRunners = new Set<string>();
  private closed = false;

  private constructor(
    store: Store,
    dbPath: string,
    startedAt: string,
    fetchImpl: FetchLike,
    defaultLaneRunner: LaneRunner,
    extraLaneRunners: Map<string, LaneRunner>,
    realLaneExecution: boolean,
    laneWorkspacesRoot: string | null,
    laneAllowedTools: string[],
    tmux: TmuxController,
    codingRuntimeProber: CommandProber | undefined,
    cliExec: CliExec | undefined,
    approvalTimeoutMs: number,
  ) {
    this.store = store;
    this.dbPath = dbPath;
    this.startedAt = startedAt;
    this.fetchImpl = fetchImpl;
    this.defaultLaneRunner = defaultLaneRunner;
    this.extraLaneRunners = extraLaneRunners;
    this.realLaneExecution = realLaneExecution;
    this.laneWorkspacesRoot = laneWorkspacesRoot;
    this.laneAllowedTools = laneAllowedTools;
    this.tmux = tmux;
    this.codingRuntimeProber = codingRuntimeProber;
    this.cliExec = cliExec;
    this.approvalTimeoutMs = approvalTimeoutMs;
  }

  /** Open (creating + migrating) the store and start the kernel. */
  static open(opts: KernelOptions): AmritaKernel {
    const store = openStore({
      path: opts.dbPath,
      ...(opts.spillDir ? { spillDir: opts.spillDir } : {}),
    });
    const realLaneExecution =
      opts.allowRealLaneExecution ?? process.env.AMRITA_LANES_ALLOW_REAL_EXECUTION === '1';
    const configuredRoots =
      opts.laneAllowedRoots ?? parseAllowedRoots(process.env.AMRITA_LANES_ALLOWED_ROOTS);
    // When real exec is on but no roots are configured, confine to the daemon cwd.
    const allowedRoots =
      configuredRoots.length > 0 ? configuredRoots : realLaneExecution ? [process.cwd()] : [];
    // Injected runner wins (tests); else a real-capable runner iff opted in, else the
    // safe default that refuses real execution (ADR-0014/0015).
    const allowedTools =
      opts.laneAllowedTools ??
      (process.env.AMRITA_LANES_ALLOWED_TOOLS ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    const laneRunner =
      opts.laneRunner ??
      (realLaneExecution
        ? new ClaudeCodeLaneRunner({
            allowRealExecution: true,
            allowedRoots,
            ...(allowedTools.length > 0 ? { allowedTools } : {}),
          })
        : new ClaudeCodeLaneRunner());
    // Kind-dispatched runners (ADR-0023): research ships unwired (honest
    // needs-setup abort); injected extras override by kind (tests wire a provider).
    const extraLaneRunners = new Map<string, LaneRunner>();
    // Codex is the ChatGPT-subscription twin of the default runner: real when
    // the daemon opted in, otherwise the safe refusal (same posture, ADR-0015).
    const codexRunner = realLaneExecution
      ? new CodexLaneRunner({ allowRealExecution: true, allowedRoots })
      : new CodexLaneRunner();
    // Interactive tmux sessions (ADR-0049): register only on a real-exec daemon —
    // there is no "safe refusal" variant, so on a non-opted daemon the `*-tmux` kinds
    // stay unknown and abort honestly. Tests override by kind via `extraLaneRunners`.
    const tmux = opts.tmuxController ?? createNodeTmuxController();
    const tmuxSessionRunners: LaneRunner[] = realLaneExecution
      ? [
          new TmuxSessionLaneRunner({ agent: 'claude', tmux, allowedRoots }),
          new TmuxSessionLaneRunner({ agent: 'codex', tmux, allowedRoots }),
        ]
      : [];
    for (const r of [
      new ResearchLaneRunner(),
      codexRunner,
      ...tmuxSessionRunners,
      ...(opts.extraLaneRunners ?? []),
    ]) {
      extraLaneRunners.set(r.kind, r);
    }
    const kernel = new AmritaKernel(
      store,
      opts.dbPath,
      new Date().toISOString(),
      opts.fetchImpl ?? defaultFetch,
      laneRunner,
      extraLaneRunners,
      realLaneExecution,
      allowedRoots[0] ?? null,
      allowedTools,
      tmux,
      opts.codingRuntimeProber,
      opts.cliExec,
      // Deny-by-default stays; only the WINDOW is tunable. 120s proved too short
      // for a human to notice the approval card after a chat-spawned session —
      // the operator saw "aborted: approval timed out" as "it just doesn't work".
      opts.approvalTimeoutMs ??
        (Number(process.env.AMRITA_APPROVAL_TIMEOUT_MS ?? '') > 0
          ? Number(process.env.AMRITA_APPROVAL_TIMEOUT_MS)
          : 120_000),
    );
    // ADR-0048: terminalize lanes orphaned by a previous crash before serving.
    kernel.reconcileLanesOnBoot();
    return kernel;
  }

  /** Resolve the runner for a lane kind (ADR-0023). Unknown kinds get none — the lane aborts honestly. */
  private laneRunnerFor(kind: string): LaneRunner | undefined {
    if (kind === 'claude-code' || kind === this.defaultLaneRunner.kind) {
      return this.defaultLaneRunner;
    }
    return this.extraLaneRunners.get(kind);
  }

  close(): void {
    this.closed = true;
    // Abort in-flight (detached) HEADLESS lanes so no child outlives the daemon.
    // DURABLE (tmux) sessions are deliberately left running — they outlive the daemon
    // and are RE-ATTACHED on the next boot (ADR-0049); aborting them here would defeat
    // the whole point. On a clean shutdown their promise is simply detached.
    for (const { controller, durable } of this.activeLanes.values()) {
      if (!durable) controller.abort();
    }
    this.activeLanes.clear();
    // Reap every tracked CLI subprocess (chat turns, probes) as a process group —
    // an aborted lane resolves before its child exits, and a chat exec is not on
    // the lane list at all, so without this they leak past daemon shutdown.
    killAllCliExec();
    for (const pending of this.pendingApprovals.values()) pending.settle('deny');
    this.pendingApprovals.clear();
    this.workspaceTickets.clear();
    this.streamListeners.clear();
    this.store.close();
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  health(): KernelHealth {
    const version = (
      this.store.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
        v: number | null;
      }
    ).v;
    return {
      ok: true,
      name: 'amritad',
      startedAt: this.startedAt,
      dbPath: this.dbPath,
      schemaVersion: version ?? -1,
      counts: this.store.stats(),
      lanes: { realExecution: this.realLaneExecution, active: this.activeLanes.size },
    };
  }

  // ── projects & conversations ───────────────────────────────────────────────

  /** Get the project with this slug, creating it if absent. */
  ensureProject(input: { slug: string; name: string; root?: string }): ProjectRow {
    const existing = this.store.getProjectBySlug(input.slug);
    if (existing) return existing;
    return this.store.createProject(input);
  }

  getProject(idOrSlug: { id?: string; slug?: string }): ProjectRow | undefined {
    if (idOrSlug.id) return this.store.getProject(idOrSlug.id);
    if (idOrSlug.slug) return this.store.getProjectBySlug(idOrSlug.slug);
    return undefined;
  }

  listProjects(): ProjectRow[] {
    return this.store.listProjects();
  }

  createConversation(input: {
    projectId: string;
    title?: string;
    parentId?: string;
  }): ConversationRow {
    return this.store.createConversation(input);
  }

  getConversationTree(conversationId: string): ConversationNode[] {
    return this.store.getConversationTree(conversationId);
  }

  getConversation(conversationId: string): ConversationNode | undefined {
    return this.store.getConversation(conversationId);
  }

  listConversations(projectId: string): ConversationNode[] {
    return this.store.listConversations(projectId);
  }

  recordUserMessage(input: {
    projectId: string;
    conversationId: string;
    text: string;
    channel?: EntityWriteOpts['channel'];
  }): { messageId: string; event: AmritaEvent } {
    const { message, event } = this.store.recordUserMessage(clean(input));
    return { messageId: message.id, event };
  }

  listEvents(conversationId: string, sinceSeq?: number): AmritaEvent[] {
    return this.store.getEvents(conversationId, sinceSeq ?? 0);
  }

  /** Archive a session (ADR-0038): the event does the work; history stays. */
  archiveConversation(conversationId: string): { ok: true } {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error(`no such conversation: ${conversationId}`);
    if (conv.archivedAt) return { ok: true }; // idempotent
    this.store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId: conv.projectId,
      conversationId,
      origin: 'user',
      type: 'conversation.archived',
      payload: {},
    } as UnsealedEvent);
    return { ok: true };
  }

  /** Delete a project and everything it owns (ADR-0038). `system` is refused. */
  deleteProject(projectId: string): { deleted: true } {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`no such project: ${projectId}`);
    if (project.slug === 'system') {
      throw new Error('conflict: the reserved system project cannot be deleted');
    }
    return this.store.deleteProject(projectId);
  }

  /**
   * Compress a conversation into a lineage child (ADR-0033): the child starts
   * with a deterministic digest as `message.system`, the parent records
   * `conversation.compressed` and is archived. The log is never rewritten.
   */
  compressConversation(conversationId: string): {
    childConversationId: string;
    summary: string;
    messageCount: number;
  } {
    const conv = this.store.getConversation(conversationId);
    if (!conv) throw new Error(`no such conversation: ${conversationId}`);
    if (conv.archivedAt) {
      throw new Error(
        `conflict: conversation ${conversationId} is already archived — continue in its compression child`,
      );
    }
    const messages = this.store.listMessages(conversationId);
    if (messages.length === 0) {
      throw new Error('conflict: nothing to compress — the conversation has no messages');
    }
    const summary = buildCompressionDigest(conv.title, messages);
    const child = this.store.createConversation({
      projectId: conv.projectId,
      title: `${conv.title ?? 'conversation'} · continued`,
      parentId: conversationId,
    });
    this.store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId: conv.projectId,
      conversationId: child.id,
      origin: 'system',
      type: 'message.system',
      payload: { text: summary },
    } as UnsealedEvent);
    this.store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId: conv.projectId,
      conversationId,
      origin: 'system',
      type: 'conversation.compressed',
      payload: { childConversationId: child.id, summary, messageCount: messages.length },
    } as UnsealedEvent);
    this.store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId: conv.projectId,
      conversationId,
      origin: 'system',
      type: 'conversation.archived',
      payload: {},
    } as UnsealedEvent);
    // ADR-0033 amendment (session→memory-layers): the digest ALSO lands in the
    // project's memory layer, so the Brain keeps every session's summary with
    // chat provenance — the conversation is the session, the memory is durable.
    this.store.putMemoryEntry({
      projectId: conv.projectId,
      conversationId: child.id,
      scope: 'project',
      content: summary.slice(0, 4000),
      source: `session:compress:${conversationId}`,
      origin: 'system',
    });
    return { childConversationId: child.id, summary, messageCount: messages.length };
  }

  /** Read-only project context: git + files, bounded probes (ADR-0034). */
  async getProjectContext(projectId: string): Promise<ProjectContextWire> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`no such project: ${projectId}`);
    if (!project.root) {
      return { projectId, configured: false, root: null, exists: false, git: null, files: null };
    }
    if (!rootExists(project.root)) {
      return {
        projectId,
        configured: true,
        root: project.root,
        exists: false,
        git: null,
        files: null,
      };
    }
    const git = await probeGitContext(project.root, this.codingRuntimeProber ?? undefined);
    return {
      projectId,
      configured: true,
      root: project.root,
      exists: true,
      git,
      files: summarizeFiles(project.root),
    };
  }

  /** The skill registry (ADR-0035): register + gate, never execute. */
  listSkills(projectId?: string): SkillStatus[] {
    const root = projectId ? (this.store.getProject(projectId)?.root ?? undefined) : undefined;
    return loadSkillStatuses(root ? { projectRoot: root } : {});
  }

  // ── chat turn + providers ────────────────────────────────────────────────

  /**
   * Provider availability from account config + env/setting presence (sync,
   * presence-only — no probes, no secret values). Availability semantics per
   * auth mode: api_key = bound account with its env var present;
   * subscription_cli = a connected account (login state is probed live by
   * `providers.catalog` / first turn); local_endpoint = endpoint configured.
   */
  listProviders(): ProviderInfo[] {
    const accounts = this.store.listAccounts();
    return [
      {
        id: MOCK_PROVIDER_ID,
        kind: 'mock',
        available: true,
        configuredAccounts: 0,
        envReady: false,
        streaming: true, // MockProvider implements generateStream (ADR-0016)
      },
      ...REAL_PROVIDERS.map((spec): ProviderInfo => {
        const all = accounts.filter((a) => a.provider === spec.id);
        const bound = all.filter((a) => a.secretRef);
        const envReady = bound.some((a) => a.secretRef !== null && envPresent(a.secretRef));
        let available = false;
        if (spec.executable) {
          if (spec.authMode === 'api_key') available = envReady;
          else if (spec.authMode === 'subscription_cli') available = all.length > 0;
          else if (spec.authMode === 'local_endpoint') {
            available = parseLocalEndpoint(this.getSetting(LOCAL_ENDPOINT_SETTING)) !== undefined;
          }
        }
        return {
          id: spec.id,
          kind: 'real',
          available,
          configuredAccounts: spec.authMode === 'api_key' ? bound.length : all.length,
          envReady,
          streaming: spec.streaming,
          title: spec.title,
          group: spec.group,
          authMode: spec.authMode,
          executable: spec.executable,
        };
      }),
    ];
  }

  /**
   * The provider CATALOG (ADR-0025): everything a chooser UI needs, with live
   * bounded CLI probes for login providers. States are honest — `ready` only
   * after real evidence; detection-only entries say exactly why they cannot
   * run; nothing ever silently disappears.
   */
  async providersCatalog(): Promise<ProviderCatalogEntry[]> {
    const accounts = this.store.listAccounts();
    const localCfg = parseLocalEndpoint(this.getSetting(LOCAL_ENDPOINT_SETTING));
    return Promise.all(
      REAL_PROVIDERS.map(async (spec): Promise<ProviderCatalogEntry> => {
        const base = {
          id: spec.id,
          title: spec.title,
          group: spec.group,
          authMode: spec.authMode,
          defaultModel: spec.defaultModel,
          executable: spec.executable,
          ...(spec.envName ? { envName: spec.envName } : {}),
          ...(spec.keyUrl ? { keyUrl: spec.keyUrl } : {}),
          ...(spec.installHint ? { installHint: spec.installHint } : {}),
        };
        if (spec.authMode === 'api_key') {
          const bound = accounts.filter((a) => a.provider === spec.id && a.secretRef);
          const envReady = bound.some((a) => a.secretRef !== null && envPresent(a.secretRef));
          if (envReady) {
            const envName = bound.find((a) => a.secretRef && envPresent(a.secretRef))?.secretRef;
            return {
              ...base,
              state: 'ready',
              detail: `key present via ${envName ?? spec.envName}`,
            };
          }
          if (bound.length > 0) {
            return {
              ...base,
              state: 'needs_key',
              detail: `account bound to ${bound[0]?.secretRef}, but that env var has no value`,
              fix: 'amrita setup',
            };
          }
          return { ...base, state: 'needs_key', detail: 'no key configured', fix: 'amrita setup' };
        }
        if (spec.authMode === 'local_endpoint') {
          if (localCfg) {
            return {
              ...base,
              state: 'ready',
              detail: `endpoint ${localCfg.baseUrl} · model ${localCfg.model}`,
            };
          }
          return {
            ...base,
            state: 'needs_endpoint',
            detail: 'no endpoint configured (Ollama default: http://localhost:11434/v1)',
            fix: 'amrita setup',
          };
        }
        // login providers (subscription_cli / oauth): bounded live CLI probe.
        return this.loginProviderCatalogEntry(spec, base);
      }),
    );
  }

  /** Catalog state for a login (CLI-session) provider, via bounded probes. */
  private async loginProviderCatalogEntry(
    spec: RealProviderSpec,
    base: Omit<ProviderCatalogEntry, 'state' | 'detail' | 'fix'>,
  ): Promise<ProviderCatalogEntry> {
    if (spec.id === 'claude-code') {
      const st = await getClaudeCodeStatus({
        realExecution: this.realLaneExecution,
        ...(this.codingRuntimeProber ? { prober: this.codingRuntimeProber } : {}),
        timeoutMs: CATALOG_PROBE_TIMEOUT_MS,
      });
      if (st.state === 'ready') {
        return {
          ...base,
          state: 'ready',
          detail: `logged in via Claude Code${st.version ? ` (${st.version})` : ''} — subscription session; no API key exists anywhere`,
        };
      }
      if (st.state === 'not_installed') {
        return {
          ...base,
          state: 'missing_cli',
          detail: 'the `claude` CLI was not found on PATH',
          fix: spec.installHint ?? '',
        };
      }
      if (st.state === 'installed_unauthenticated') {
        return {
          ...base,
          state: 'needs_login',
          detail: 'Claude Code is installed but not logged in',
          fix: 'claude  # log in once interactively',
        };
      }
      return {
        ...base,
        state: 'needs_login',
        detail: 'Claude Code is installed; login state could not be verified in time',
        fix: 'claude auth status',
      };
    }
    if (spec.id === 'codex-cli') {
      const prober = this.codingRuntimeProber ?? (await import('./runtimes.ts')).defaultProber;
      const version = await prober('codex', ['--version'], CATALOG_PROBE_TIMEOUT_MS);
      if (version.kind !== 'ok') {
        return {
          ...base,
          state: 'missing_cli',
          detail: 'the `codex` CLI was not found on PATH',
          fix: spec.installHint ?? '',
        };
      }
      const login = await prober('codex', ['login', 'status'], CATALOG_PROBE_TIMEOUT_MS);
      if (login.kind === 'ok') {
        return {
          ...base,
          state: 'ready',
          detail: 'logged in via Codex — ChatGPT subscription session; no API key exists anywhere',
        };
      }
      return {
        ...base,
        state: 'needs_login',
        detail: 'Codex is installed but not logged in',
        fix: 'codex login',
      };
    }
    // Generic detection-only login provider: detect, never run.
    const probe = this.codingRuntimeProber;
    const cli = spec.detectCli ?? spec.id;
    const found = probe
      ? (await probe(cli, ['--version'], CATALOG_PROBE_TIMEOUT_MS)).kind === 'ok'
      : await import('./runtimes.ts').then((m) =>
          m
            .defaultProber(cli, ['--version'], CATALOG_PROBE_TIMEOUT_MS)
            .then((r) => r.kind === 'ok'),
        );
    if (!found) {
      return {
        ...base,
        state: 'missing_cli',
        detail: `the \`${cli}\` CLI was not found on PATH`,
        fix: spec.installHint ?? '',
      };
    }
    return {
      ...base,
      state: 'unavailable',
      detail: `${cli} CLI detected, but Amrita cannot run chat through it yet — use an OpenAI API key or OpenRouter today`,
    };
  }

  /**
   * Live model discovery for a provider (ADR-0026 / Hermes /models probe). Hits
   * the OpenAI-compatible `/models` endpoint when the provider supports it,
   * resolving the base URL and key the same way a chat turn would. Falls back to
   * the curated catalog list when discovery is unsupported or fails — never an
   * empty pick list, never a thrown error, never a secret.
   */
  async discoverModels(
    providerId: string,
  ): Promise<{ provider: string; models: string[]; source: 'live' | 'curated'; detail: string }> {
    const spec = findProviderSpec(providerId);
    if (!spec) throw new ProviderError('unknown_provider', `unknown provider: ${providerId}`);
    const curated = [...(spec.models ?? [])];
    const fallback = (detail: string) => ({
      provider: spec.id,
      models: curated,
      source: 'curated' as const,
      detail,
    });
    if (!spec.supportsModelDiscovery) {
      return fallback('provider does not support live discovery; showing curated list');
    }

    let baseUrl = spec.baseUrl;
    let apiKey: string | undefined;
    if (spec.authMode === 'local_endpoint') {
      const cfg = parseLocalEndpoint(this.getSetting(LOCAL_ENDPOINT_SETTING));
      if (!cfg) return fallback('local endpoint not configured');
      baseUrl = cfg.baseUrl;
      apiKey = cfg.keyEnv ? readEnvSecret(cfg.keyEnv) : undefined;
    } else {
      const override = spec.baseUrlEnvVar ? process.env[spec.baseUrlEnvVar] : undefined;
      baseUrl = override && override.length > 0 ? override : spec.baseUrl;
      const account = this.store.listAccounts().find((a) => a.provider === spec.id && a.secretRef);
      apiKey = account?.secretRef ? readEnvSecret(account.secretRef) : undefined;
    }
    if (!baseUrl) return fallback('no base URL to probe');

    const probe: ModelDiscovery = await probeOpenAiModels({
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      fetchImpl: this.fetchImpl,
    });
    if (!probe.ok || probe.models.length === 0) {
      return fallback(`live discovery failed (${probe.detail}); showing curated list`);
    }
    return { provider: spec.id, models: probe.models, source: 'live', detail: probe.detail };
  }

  /**
   * Probe an arbitrary OpenAI-compatible endpoint during setup (before it is
   * persisted) — `/models` discovery plus the local `/v1` hint (Hermes custom
   * endpoint flow). `keyEnv` is an env-var NAME; its value is read here only.
   * Never throws, never returns a secret.
   */
  async probeEndpoint(
    baseUrl: string,
    keyEnv?: string,
  ): Promise<ModelDiscovery & { suggestedUrl?: string }> {
    const suggested = suggestV1BaseUrl(baseUrl);
    const effectiveUrl = suggested ?? baseUrl;
    const apiKey = keyEnv ? readEnvSecret(keyEnv) : undefined;
    const probe = await probeOpenAiModels({
      baseUrl: effectiveUrl,
      ...(apiKey ? { apiKey } : {}),
      fetchImpl: this.fetchImpl,
    });
    return { ...probe, ...(suggested ? { suggestedUrl: suggested } : {}) };
  }

  /** The settings-backed role binding at a scope, if set and well-formed. */
  getRoleBinding(role: ProviderRole, projectId?: string): RoleBinding | undefined {
    return parseRoleBinding(this.store.getSetting(roleSettingKey(role, projectId)));
  }

  /**
   * Coding runtimes (ADR-0019 / §2.9): probed honestly, independent of the
   * brain model. Claude Code is the first bridge; future bridges join this list
   * only with a real status probe behind them.
   */
  async getCodingRuntimes(): Promise<CodingRuntimeStatus[]> {
    const now = Date.now();
    if (this.runtimesCache && now - this.runtimesCache.at < 30_000) {
      return this.runtimesCache.value;
    }
    const value = await getRuntimesStatus({
      realExecution: this.realLaneExecution,
      ...(this.codingRuntimeProber ? { prober: this.codingRuntimeProber } : {}),
      ...(this.laneAllowedTools.length > 0 ? { claudeAllowedTools: this.laneAllowedTools } : {}),
    });
    this.runtimesCache = { at: now, value };
    return value;
  }

  /**
   * The (projectId, conversationId) envelope for system-level config writes
   * (mirrors the CLI's convention: the `system` project's `(default)` sink).
   */
  private systemWriteContext(): { projectId: string; conversationId: string } {
    const project = this.ensureProject({ slug: 'system', name: 'System' });
    const existing = this.store.listConversations(project.id).find((c) => c.title === '(default)');
    const conversationId =
      existing?.id ??
      this.store.createConversation({ projectId: project.id, title: '(default)' }).id;
    return { projectId: project.id, conversationId };
  }

  /** Bind a role to a provider (global, or one project's scope). Validated, secret-free. */
  setRoleBinding(input: {
    role: ProviderRole;
    provider: string;
    model?: string;
    projectId?: string;
  }): { ok: true } {
    // Normalize aliases (`claude`→`anthropic`, `grok`→…) so the binding stores
    // a canonical id (ADR-0026 / Hermes alias lesson).
    const provider = normalizeProvider(input.provider);
    if (provider !== MOCK_PROVIDER_ID && !this.listProviders().some((p) => p.id === provider)) {
      throw new ProviderError('unknown_provider', `unknown provider: ${input.provider}`);
    }
    if (input.projectId && !this.store.getProject(input.projectId)) {
      throw new ProviderError('not_found', `no such project: ${input.projectId}`);
    }
    this.store.updateSetting({
      ...this.systemWriteContext(),
      key: roleSettingKey(input.role, input.projectId),
      value: { provider, ...(input.model ? { model: input.model } : {}) },
    });
    return { ok: true };
  }

  /** Remove a role binding at a scope; resolution falls back (project→global→auto). */
  clearRoleBinding(input: { role: ProviderRole; projectId?: string }): { ok: true } {
    this.store.updateSetting({
      ...this.systemWriteContext(),
      key: roleSettingKey(input.role, input.projectId),
      value: null,
    });
    return { ok: true };
  }

  /**
   * Resolve a ROLE to a concrete provider id (+ optional model) — D5/ADR-0017.
   * Scope order: the project's binding (when a projectId is given) wins over
   * the global binding; otherwise `auto`: the first *available* real provider
   * (bound account + env present), else the deterministic mock. Deterministic
   * and secret-free; the chosen path is reported in `via`.
   */
  resolveRole(
    role: ProviderRole,
    projectId?: string,
  ): RoleBinding & { via: 'project' | 'binding' | 'auto' } {
    if (projectId) {
      const project = this.getRoleBinding(role, projectId);
      if (project) return { ...project, via: 'project' };
    }
    const binding = this.getRoleBinding(role);
    if (binding) return { ...binding, via: 'binding' };
    const firstReal = this.listProviders().find((p) => p.kind === 'real' && p.available);
    return { provider: firstReal?.id ?? MOCK_PROVIDER_ID, via: 'auto' };
  }

  /**
   * Resolve the concrete provider for a turn. For real providers this reads the
   * account's bound `secret_ref` env var **here only** and hands the value to the
   * adapter; the value never leaves this method. Throws a structured, secret-free
   * `ProviderError` for any config/availability problem.
   */
  private resolveChatProvider(
    input: ChatTurnInput,
    projectId?: string,
  ): {
    providerId: string;
    model: string;
    provider: ChatProvider;
    role: ProviderRole;
    /** Selection-scope provenance, persisted on model.request (ADR-0019). */
    via: 'explicit' | 'project' | 'binding' | 'auto' | 'default';
  } {
    const role: ProviderRole = input.role ?? 'main';
    let account = input.accountId
      ? this.store.listAccounts().find((a) => a.id === input.accountId)
      : undefined;
    if (input.accountId && !account) {
      throw new ProviderError('not_found', `no such account: ${input.accountId}`);
    }
    // An explicit provider/account always wins; otherwise an explicit role
    // resolves via its settings binding or `auto` (D5/ADR-0017).
    let roleModel: string | undefined;
    let requested = input.provider ?? account?.provider;
    let via: 'explicit' | 'project' | 'binding' | 'auto' | 'default' = requested
      ? 'explicit'
      : 'default';
    if (!requested && input.role) {
      const resolved = this.resolveRole(input.role, projectId);
      requested = resolved.provider;
      roleModel = resolved.model;
      via = resolved.via;
    }
    const providerId = normalizeProvider(requested ?? MOCK_PROVIDER_ID);
    if (account && input.provider && input.provider !== account.provider) {
      throw new ProviderError(
        'unknown_provider',
        `account provider '${account.provider}' does not match requested '${input.provider}'`,
      );
    }

    if (providerId === MOCK_PROVIDER_ID) {
      return {
        providerId,
        model: input.model ?? roleModel ?? 'mock-default',
        provider: this.mock,
        role,
        via,
      };
    }

    const spec = REAL_PROVIDERS.find((p) => p.id === providerId);
    if (!spec) throw new ProviderError('unknown_provider', `unknown provider: ${providerId}`);
    if (!spec.executable || !spec.create) {
      // Detection-only catalog entry (e.g. codex): never pretend to run it.
      throw new ProviderError(
        'provider_unavailable',
        `${spec.id} is detection-only — Amrita cannot run chat through it yet (use an API-key provider, OpenRouter, or a local endpoint)`,
      );
    }

    // Subscription login (claude-code): chat runs through the locally
    // logged-in CLI. No key, no secretRef — no secret value exists in Amrita.
    if (spec.authMode === 'subscription_cli') {
      const model = input.model ?? roleModel ?? spec.defaultModel;
      return {
        providerId,
        model,
        provider: spec.create({
          apiKey: '', // unused by the CLI adapter; the CLI holds the session
          model,
          ...(this.cliExec ? { execImpl: this.cliExec } : {}),
        }),
        role,
        via,
      };
    }

    // Local OpenAI-compatible endpoint: config lives in settings (non-secret);
    // an optional key env NAME may be referenced — its value is read here only.
    if (spec.authMode === 'local_endpoint') {
      const cfg = parseLocalEndpoint(this.getSetting(LOCAL_ENDPOINT_SETTING));
      if (!cfg) {
        throw new ProviderError(
          'provider_unavailable',
          'local endpoint is not configured — run `amrita setup` (local section)',
        );
      }
      const apiKey = (cfg.keyEnv ? readEnvSecret(cfg.keyEnv) : undefined) ?? 'local';
      const model = input.model ?? roleModel ?? cfg.model;
      return {
        providerId,
        model,
        provider: spec.create({ apiKey, model, baseUrl: cfg.baseUrl, fetchImpl: this.fetchImpl }),
        role,
        via,
      };
    }

    // api_key providers — default account rule: first bound account.
    if (!account) {
      account = this.store.listAccounts().find((a) => a.provider === providerId && a.secretRef);
      if (!account) {
        throw new ProviderError('not_found', `no configured account for provider '${providerId}'`);
      }
    }
    if (!account.secretRef) {
      throw new ProviderError(
        'missing_secret_ref',
        `account ${account.id} has no secret_ref bound`,
      );
    }
    const apiKey = readEnvSecret(account.secretRef); // the ONLY secret-value read
    if (!apiKey) {
      throw new ProviderError('missing_env_value', `env var ${account.secretRef} is not set`);
    }
    const model = input.model ?? roleModel ?? spec.defaultModel;
    // A base-URL env override (e.g. OPENROUTER_BASE_URL) wins over the catalog
    // default — non-secret, read here only (ADR-0026 / Hermes base_url_env_var).
    const baseUrlOverride = spec.baseUrlEnvVar ? process.env[spec.baseUrlEnvVar] : undefined;
    const baseUrl = baseUrlOverride && baseUrlOverride.length > 0 ? baseUrlOverride : spec.baseUrl;
    return {
      providerId,
      model,
      provider: spec.create({
        apiKey,
        model,
        fetchImpl: this.fetchImpl,
        ...(baseUrl ? { baseUrl } : {}),
      }),
      role,
      via,
    };
  }

  /**
   * Subscribe to STREAM-ONLY events (`model.delta`). These are sealed with
   * `seq: 0` (the store never assigns them a seq — D8 forbids persisting them)
   * and fan out only to live listeners (the WS surface). Listener errors are
   * swallowed so a bad subscriber can never break a turn.
   */
  subscribeStream(listener: (ev: AmritaEvent) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  /** Emit one stream-only `model.delta`, parsed by the protocol before fan-out. */
  private emitStreamDelta(
    projectId: string,
    conversationId: string,
    turnId: string,
    text: string,
  ): void {
    if (this.closed || this.streamListeners.size === 0) return;
    const ev = parseEvent({
      id: newId(),
      seq: 0, // stream-only: never store-sealed, never persisted
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      turnId,
      origin: 'agent',
      type: 'model.delta',
      payload: { text },
    });
    for (const listener of this.streamListeners) {
      try {
        listener(ev);
      } catch {
        // a subscriber must never break the turn
      }
    }
  }

  private sessionGoalWasSent(conversationId: string, laneId: string): boolean {
    if (this.sessionGoalSentLanes.has(laneId)) return true;
    const sent = this.store
      .getEvents(conversationId, 0)
      .some(
        (event) =>
          event.laneId === laneId &&
          event.type === 'lane.progress' &&
          (event.payload as { note?: unknown }).note === SESSION_GOAL_SENT_PROGRESS,
      );
    if (sent) this.sessionGoalSentLanes.add(laneId);
    return sent;
  }

  /** Emit one stream-only `lane.pane` (ADR-0050) — the live tmux tail, never stored. */
  private emitLanePane(
    projectId: string,
    conversationId: string,
    laneId: string,
    text: string,
  ): void {
    if (this.closed || this.streamListeners.size === 0) return;
    // The daemon boundary owns redaction and bounding even when a future/injected
    // runner forgets to sanitize its pane before invoking the callback.
    const safeText = redactPane(text).slice(-64_000);
    const boot = classifyBootPane(safeText);
    const goalSent = this.sessionGoalWasSent(conversationId, laneId);
    const state: SessionRuntimeState =
      boot === 'login'
        ? 'awaiting-auth'
        : boot === 'prompt' || boot === 'blocked' || safeText.trim().length === 0 || !goalSent
          ? 'starting'
          : 'running';
    const ev = parseEvent({
      id: newId(),
      seq: 0, // stream-only: never store-sealed, never persisted
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      laneId,
      origin: 'lane',
      type: 'lane.pane',
      payload: { laneId, text: safeText, state },
    });
    for (const listener of this.streamListeners) {
      try {
        listener(ev);
      } catch {
        // a subscriber must never break the run
      }
    }
  }

  /** Append a turn-scoped event (turn/model namespaces) via the Store API. */
  private emitTurnEvent(
    projectId: string,
    conversationId: string,
    turnId: string,
    type: string,
    payload: unknown,
  ): AmritaEvent {
    return this.store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      turnId,
      origin: 'agent',
      type,
      payload,
    } as UnsealedEvent);
  }

  /**
   * Run one non-streaming chat turn: record the user message, `await` the provider
   * boundary (a side effect, OUTSIDE any store transaction), then persist the
   * assistant message + turn/model events. Defaults to the deterministic `mock`
   * provider; a real provider needs a bound account + present env var. The result
   * contains no secret values.
   */
  async runChatTurn(input: ChatTurnInput): Promise<ChatTurnResult> {
    const conv = this.store.getConversation(input.conversationId);
    if (!conv) {
      throw new ProviderError('not_found', `no such conversation: ${input.conversationId}`);
    }
    const projectId = conv.projectId;

    // Resolve the provider first — a config error records nothing. Role
    // resolution is project-aware (project binding > global > auto).
    const { providerId, model, provider, role, via } = this.resolveChatProvider(input, projectId);
    const turnId = newId();
    const channel = input.channel;

    const user = this.store.recordUserMessage({
      projectId,
      conversationId: input.conversationId,
      text: input.text,
      turnId,
      ...(channel ? { channel } : {}),
    });

    if (input.dryRun) {
      return {
        turnId,
        provider: providerId,
        model,
        role,
        userMessageId: user.message.id,
        userEvent: user.event,
        dryRun: true,
        assistantMessageId: null,
        assistantEvent: null,
        text: null,
        finishReason: null,
        usage: null,
      };
    }

    this.emitTurnEvent(projectId, input.conversationId, turnId, 'turn.started', {
      trigger: 'user',
    });
    this.emitTurnEvent(projectId, input.conversationId, turnId, 'model.request', {
      provider: providerId,
      model,
      role,
      via,
    });

    // Provider call — pure side effect, outside any store transaction.
    //
    // ADR-0044: the transcript is prefixed with the Project Context Pack — the
    // live, bounded state of this project — as ONE system message. Before this,
    // the model received the raw transcript and nothing else, so the
    // "project-aware agent OS" was not, in fact, project-aware at the chat layer.
    //
    // It is a plain `system` ChatMessage, NOT a new provider field, because every
    // adapter already handles the system role correctly: Anthropic lifts it into
    // the `system` param, OpenAI passes the role through, and the CLI providers'
    // `flattenTranscript` puts it first. Reuse the seam that exists.
    //
    // It is deliberately NOT persisted: injecting it as a `message.system` event
    // would pollute the transcript and the event log with a value that is derived
    // (and rebuilt every turn anyway). The persisted record of the turn is
    // unchanged, so the log stays byte-identical to the pre-ADR-0044 world.
    const transcript = this.store
      .listMessages(input.conversationId)
      .map((m) => ({ role: m.role, text: m.text }));
    // ADR-0051: the RELAY seam runs BEFORE the provider call — if this message is
    // "תבחרי אופציה 2", the input reaches the session FIRST and the reply then
    // truthfully confirms the outcome (instead of "I have no window into the
    // session"). Best-effort: a relay failure degrades to a note, never a
    // failed turn.
    let relayNote: string | null = null;
    try {
      relayNote = await this.runRelay(projectId, input.conversationId, input.text);
    } catch {
      relayNote = null;
    }
    const pack = await this.buildContextPack(projectId);
    // ADR-0045: what the operator is LOOKING AT. Appended to the pack rather than
    // baked into it, so the pack stays cacheable-by-value and focus stays per-turn.
    const focus = this.renderFocus(projectId, input.focus);
    const system = [pack, relayNote, focus].filter(Boolean).join('\n\n');
    const messages: ChatMessage[] = system
      ? [{ role: 'system', text: system }, ...transcript]
      : transcript;
    let resp: Awaited<ReturnType<ChatProvider['generate']>>;
    try {
      // Prefer the provider's streaming path: incremental text is fanned out as
      // stream-only `model.delta` (never persisted); the final response below is
      // what gets persisted as `model.response` + `message.agent`.
      resp = provider.generateStream
        ? await provider.generateStream({ messages, model }, (text) =>
            this.emitStreamDelta(projectId, input.conversationId, turnId, text),
          )
        : await provider.generate({ messages, model });
    } catch (e) {
      const message = e instanceof ProviderError ? e.message : `${providerId} request failed`;
      this.emitTurnEvent(projectId, input.conversationId, turnId, 'turn.failed', {
        error: message,
      });
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('provider_error', message);
    }

    this.emitTurnEvent(projectId, input.conversationId, turnId, 'model.response', {
      text: resp.text,
      finishReason: resp.finishReason,
    });
    this.emitTurnEvent(projectId, input.conversationId, turnId, 'model.usage', resp.usage);
    const assistant = this.store.recordAgentMessage({
      projectId,
      conversationId: input.conversationId,
      text: resp.text,
      turnId,
    });
    this.emitTurnEvent(projectId, input.conversationId, turnId, 'turn.completed', {
      usage: resp.usage,
    });

    // ADR-0044: the Scribe runs AFTER the turn is complete and persisted, so it
    // can never delay a reply and a failure inside it can never fail the turn.
    // The reply above is already final; this only adds proposals to the Inbox.
    // The guard is load-bearing: runScribe does unguarded store reads (the settings
    // gate, the open-question lookups), and a transient failure there must degrade
    // to "no proposals", never surface as a failed turn to the operator.
    try {
      await this.runScribe({
        projectId,
        conversationId: input.conversationId,
        userText: input.text,
        agentText: resp.text,
        sourceMessageId: assistant.message.id,
        contextPack: pack,
      });
    } catch {
      /* the turn is already persisted; the Scribe is best-effort */
    }

    // ADR-0048: the Planner is the Scribe's sibling. Where the Scribe turns a turn
    // into Inbox proposals, the Planner turns a BUILD/RESEARCH request into a
    // delegated execution session — so Amrita supervises instead of writing code in
    // chat. Off the reply path, best-effort: a failure here never fails the turn.
    try {
      await this.runPlanner({
        projectId,
        conversationId: input.conversationId,
        userText: input.text,
      });
    } catch (err) {
      // The turn is already persisted; the Planner is best-effort. But NEVER
      // silently: a swallowed throw here once hid a broken delegation chain for
      // days ("she says she delegates, nothing opens"). Value-free breadcrumb.
      console.error(
        `amritad: planner failed (turn persisted, no session opened): ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    return {
      turnId,
      provider: providerId,
      model,
      role,
      userMessageId: user.message.id,
      userEvent: user.event,
      dryRun: false,
      assistantMessageId: assistant.message.id,
      assistantEvent: assistant.event,
      text: resp.text,
      finishReason: resp.finishReason,
      usage: resp.usage,
    };
  }

  // ── tasks ───────────────────────────────────────────────────────────────────

  createTask(
    input: {
      projectId: string;
      conversationId: string;
      title: string;
      status?: TaskStatus;
      milestoneId?: string;
      body?: string;
      sourceMessageId?: string;
      // ADR-0044: `laneId` was supported by the column, the event AND the store —
      // and silently dropped here, so a task could never point at the lane doing it.
      laneId?: string;
      owner?: string;
      dueDate?: string;
      priority?: TaskPriority;
      orderKey?: string;
      blockedReason?: string;
      certainty?: Certainty;
      phaseId?: string;
      derivedFrom?: Derivation[];
    } & EntityWriteOpts,
  ): { taskId: string } {
    return { taskId: this.store.createTask(input).taskId };
  }

  /**
   * Update a task (ADR-0044).
   *
   * `store.updateTask` has existed, fully implemented and tested, since ADR-0018 —
   * with **zero callers above the store**. No kernel method, no RPC, no UI. The
   * `task.updated` event and its reducer were written and then never reached.
   * This method is the missing wire: it is what makes re-staging, retitling,
   * re-owning, dating, prioritizing, blocking and DRAGGING a card possible.
   *
   * Every field: absent = leave alone, `null` = clear.
   */
  updateTask(
    input: {
      projectId: string;
      conversationId: string;
      taskId: string;
      status?: TaskStatus;
      title?: string;
      body?: string;
      milestoneId?: string | null;
      owner?: string | null;
      dueDate?: string | null;
      priority?: TaskPriority | null;
      orderKey?: string;
      blockedReason?: string | null;
      certainty?: Certainty | null;
      phaseId?: string | null;
      derivedFrom?: Derivation[];
      /** ADR-0045: WHY the change was made. Lives on the event, not the row. */
      reason?: string;
      /** ADR-0045: the row `version` the caller saw. Mismatch ⇒ `conflict`. */
      expectedVersion?: number;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.updateTask(input);
    return { ok: true };
  }

  listTasks(filters: {
    projectId?: string;
    conversationId?: string;
    status?: TaskStatus;
  }): TaskRow[] {
    return this.store.listTasks(filters);
  }

  completeTask(
    input: { projectId: string; conversationId: string; taskId: string } & EntityWriteOpts,
  ): {
    ok: true;
  } {
    this.store.completeTask(input);
    return { ok: true };
  }

  // ── project companion (ADR-0018) ──────────────────────────────────────────

  /** Everything the Project Brain needs in one read. No fake data: empty is empty. */
  getCompanion(projectId: string): {
    brief: ProjectBriefRow | null;
    brand: ProjectBrandRow | null;
    questions: OpenQuestionRow[];
    risks: RiskRow[];
    milestones: MilestoneRow[];
    previewApprovals: PreviewApprovalRow[];
  } {
    return {
      brief: this.store.getBrief(projectId) ?? null,
      brand: this.store.getBrand(projectId) ?? null,
      questions: this.store.listQuestions({ projectId }),
      risks: this.store.listRisks({ projectId }),
      milestones: this.store.listMilestones({ projectId }),
      previewApprovals: this.store.listPreviewApprovals(projectId),
    };
  }

  /**
   * Render what the operator has open (ADR-0045).
   *
   * "אם פתחת סיכון, היא יודעת שאתה מדבר על הסיכון. אם סימנת שלוש משימות, אפשר
   *  לשאול מה הסדר הנכון ומה את יכולה לקחת ממני עכשיו?"
   *
   * Resolves the ids against real rows — a focus that points at nothing renders
   * nothing, rather than inviting the model to invent what it might have been.
   */
  private renderFocus(projectId: string, focus?: ChatFocus): string {
    if (!focus) return '';
    // ADR-0047: a build selected on the live canvas. No stored row to resolve — the
    // label IS the target. Tell the model the message is about THAT build and how
    // to change it (return the full updated HTML so the canvas re-renders).
    if (focus.kind === 'artifact') {
      if (!focus.label) return '';
      return [
        '## What the operator is looking at right now (a build on the live canvas)',
        `- "${focus.label}"`,
        '',
        'Their message is about THIS build. If they ask for a change, return the',
        'COMPLETE updated HTML in a ```html block (it re-renders live on the canvas).',
      ].join('\n');
    }
    if (focus.ids.length === 0) return '';
    const ids = new Set(focus.ids);
    const lines: string[] = [];

    switch (focus.kind) {
      case 'task':
        for (const t of this.store.listTasks({ projectId })) {
          if (ids.has(t.id)) {
            lines.push(
              `- ${t.title} [${t.status}${t.blockedReason ? `, waiting on: ${t.blockedReason}` : ''}${t.owner ? `, owner ${t.owner}` : ''}${t.dueDate ? `, due ${t.dueDate}` : ''}]`,
            );
          }
        }
        break;
      case 'risk':
        for (const r of this.store.listRisks({ projectId })) {
          if (ids.has(r.id)) lines.push(`- ${r.severity ? `[${r.severity}] ` : ''}${r.text}`);
        }
        break;
      case 'question':
        for (const q of this.store.listQuestions({ projectId })) {
          if (ids.has(q.id)) lines.push(`- ${q.text}`);
        }
        break;
      case 'decision':
        for (const d of this.store.listDecisions({ projectId })) {
          if (ids.has(d.id)) lines.push(`- ${d.text}`);
        }
        break;
      case 'milestone':
        for (const m of this.store.listMilestones({ projectId })) {
          if (ids.has(m.id)) {
            lines.push(`- ${m.title} [${m.status}${m.targetDate ? `, due ${m.targetDate}` : ''}]`);
          }
        }
        break;
      case 'phase':
        for (const p of this.store.listPhases(projectId)) {
          if (ids.has(p.id)) lines.push(`- ${p.title} [${p.status}]`);
        }
        break;
      case 'inbox':
        for (const i of this.store.listInboxItems({ projectId })) {
          if (ids.has(i.id)) lines.push(`- ${i.text}`);
        }
        break;
    }

    if (lines.length === 0) return '';
    return [
      `## What the operator is looking at right now (${focus.kind})`,
      ...lines,
      '',
      'Assume the conversation is ABOUT these unless they say otherwise. Do not make',
      'them describe again what is already on their screen.',
    ].join('\n');
  }

  /**
   * The charter's health (ADR-0045): what is missing, what Amrita only GUESSED,
   * and what cannot all be true at once — plus whether there is enough basis to
   * propose activating the project.
   */
  getCharterStatus(projectId: string): {
    findings: CharterFinding[];
    readyToActivate: boolean;
  } {
    const brief = this.store.getBrief(projectId) ?? null;
    return {
      findings: auditCharter({
        brief,
        tasks: this.store.listTasks({ projectId }),
        risks: this.store.listRisks({ projectId }),
        questions: this.store.listQuestions({ projectId }),
      }),
      readyToActivate: readyToActivate(brief),
    };
  }

  /**
   * Bind (or unbind) a project's working folder (ADR-0045).
   *
   * The browser NEVER picks a path — that is the whole reason the video's
   * File-System-Access trick is wrong here. The daemon validates the path against
   * the allowed-roots allowlist it was started with, so a project can only ever
   * point somewhere the operator already authorised at the process level.
   */
  setProjectRoot(
    input: { projectId: string; conversationId: string; root: string | null } & EntityWriteOpts,
  ): { ok: true } {
    if (input.root !== null) {
      const resolved = resolve(input.root);
      // The same allowlist a real lane is jailed to (ADR-0039). If the daemon was
      // not authorised to touch anything, a project cannot point anywhere either.
      const base = this.laneWorkspacesRoot;
      if (!base) {
        throw new Error(
          'conflict: this daemon has no allowed roots configured (AMRITA_LANES_ALLOWED_ROOTS) — a project root cannot be bound',
        );
      }
      const jail = resolve(base);
      const ok = resolved === jail || resolved.startsWith(`${jail}/`);
      if (!ok) {
        throw new Error(
          'conflict: that path is outside every allowed root — bind it to a folder the daemon was authorised to touch',
        );
      }
      if (!rootExists(resolved)) throw new Error(`not found: no such folder: ${resolved}`);
      this.store.setProjectRoot({ ...input, root: resolved });
      return { ok: true };
    }
    this.store.setProjectRoot({ ...input, root: null });
    return { ok: true };
  }

  /**
   * What can actually be done with this task right now (ADR-0045) — derived, never
   * stored, so it can never go stale.
   */
  async routeForTask(taskId: string): Promise<RouteVerdict> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`no such task: ${taskId}`);
    const project = this.store.getProject(task.projectId);
    const runtimes = await this.getCodingRuntimes();
    return routeFor({
      task,
      hasRoot: Boolean(project?.root),
      runtimeReady: runtimes.some((r) => r.state === 'ready' && r.realExecution),
      realExecution: this.realLaneExecution,
    });
  }

  /**
   * Hand a task to a lane (ADR-0045).
   *
   * "אם מעבירים משימה לסוכן, היא נפתחת בתוך מסלול הביצוע שכבר קיים באמריטה, עם
   *  הרשאות, תקציב, קבצים מותרים, נקודות עצירה וקבלה שמוכיחה מה נעשה."
   *
   * No new orchestration stack: this is `lanes.start` with a goal assembled from
   * the task and the charter, and the resulting `laneId` written back onto the card
   * so the two never drift apart. The existing approval gate, budget and receipt
   * all apply unchanged.
   */
  async delegateTask(
    input: { projectId: string; conversationId: string; taskId: string } & EntityWriteOpts,
  ): Promise<{ laneId: string; status: string }> {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new Error(`no such task: ${input.taskId}`);
    if (task.laneId) throw new Error('conflict: this task is already delegated to a lane');

    const verdict = await this.routeForTask(input.taskId);
    if (verdict.route !== 'delegate') {
      throw new Error(
        `conflict: this task cannot be delegated (${verdict.route}) — ${verdict.detail}`,
      );
    }

    const brief = this.store.getBrief(input.projectId);
    const goal = [
      task.title,
      task.body ? `\n\n${task.body}` : '',
      brief?.goal ? `\n\nProject goal: ${brief.goal}` : '',
      brief?.finishLine ? `\nDone means: ${brief.finishLine}` : '',
    ].join('');

    const lane = await this.startLane({
      conversationId: input.conversationId,
      goal,
      detach: true,
      ...(input.origin ? { origin: input.origin } : {}),
    });

    // Write the link back through the SINGLE write path (ADR-0048), in one event:
    // status→now AND the lane link. The old raw `UPDATE tasks SET lane_id` wrote it
    // OFF the event log, so the link was invisible to any event-driven watcher and
    // could crash-window-drift from the lane. It now rides `task.updated.laneId`.
    this.store.updateTask({
      projectId: input.projectId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      status: 'now',
      laneId: lane.laneId,
      reason: 'delegated to a lane',
      ...(input.origin ? { origin: input.origin } : {}),
    });

    return { laneId: lane.laneId, status: lane.status };
  }

  // ── the retrospective, and what crosses out of a project (ADR-0045) ────────

  /** What actually happened. Computed from the record, not from a model's memory. */
  buildRetro(projectId: string, now: Date = new Date()): RetroPacket {
    return buildRetroPacket({
      projectId,
      brief: this.store.getBrief(projectId) ?? null,
      tasks: this.store.listTasks({ projectId }),
      milestones: this.store.listMilestones({ projectId }),
      risks: this.store.listRisks({ projectId }),
      questions: this.store.listQuestions({ projectId }),
      decisions: this.store.listDecisions({ projectId }),
      now,
    });
  }

  /**
   * Run the retrospective: write the summary into the project, and offer the lessons
   * as PROPOSALS. Nothing leaves the project here.
   */
  runRetro(
    input: { projectId: string; conversationId: string } & EntityWriteOpts,
    now: Date = new Date(),
  ): { lessons: string[] } {
    const packet = this.buildRetro(input.projectId, now);

    this.store.appendEvent({
      id: newId(),
      ts: now.toISOString(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      origin: 'system',
      type: 'message.system',
      payload: { text: renderRetroPacket(packet) },
    } as UnsealedEvent);

    // The retro's own record stays IN the project, as project memory.
    for (const l of packet.lessons.slice(0, 10)) {
      try {
        this.store.putMemoryEntry({
          projectId: input.projectId,
          conversationId: input.conversationId,
          scope: 'project',
          content: l,
          source: 'retro',
          ...(input.origin ? { origin: input.origin } : {}),
        });
      } catch {
        // one bad lesson must not lose the retro
      }
    }

    return { lessons: packet.lessons };
  }

  /**
   * Promote ONE lesson into organizational memory (ADR-0045).
   *
   * "הלקחים לא יזלגו אוטומטית לכל הפרויקטים. אתה תאשר מה הופך לידע ארגוני, והוא
   *  יישמר עם המקור וההקשר."
   *
   * This is the only path by which anything crosses out of a project, and it is one
   * lesson at a time, by hand. The promoted entry is `user`-scoped (organizational)
   * and carries `retro:<projectId>` as its source — so the next project is always
   * told WHOSE experience it is being offered, and can disagree with it.
   *
   * There is deliberately no "promote all". Cross-project contamination is not a bug
   * you fix later; it is a door you never build.
   */
  promoteLesson(
    input: { projectId: string; conversationId: string; lesson: string } & EntityWriteOpts,
  ): { entryId: string } {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error(`no such project: ${input.projectId}`);

    const { entryId } = this.store.putMemoryEntry({
      projectId: input.projectId,
      conversationId: input.conversationId,
      // `user` scope = organizational, visible beyond this project.
      scope: 'user',
      content: `${input.lesson} (learned on: ${project.name})`,
      source: `${ORG_MEMORY_SOURCE_PREFIX}${input.projectId}`,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    return { entryId };
  }

  // ── the public stakeholder hub (ADR-0045) — SECURITY-CRITICAL ──────────────

  /** Where published bytes live. One directory, fixed, never derived from input. */
  private hubDir(): string {
    return join(dirname(this.dbPath === ':memory:' ? '.' : this.dbPath), 'public');
  }

  /**
   * The public view + its hash + whether it is currently published and in sync.
   * Reading it publishes nothing.
   */
  previewHub(
    projectId: string,
    generatedAt: string = new Date().toISOString(),
  ): {
    hub: PublicHub;
    contentHash: string;
    published: { slug: string; publishedAt: string; inSync: boolean } | null;
  } {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`no such project: ${projectId}`);

    const hub = buildPublicHub({
      project: { name: project.name },
      brief: this.store.getBrief(projectId) ?? null,
      milestones: this.store.listMilestones({ projectId }),
      phases: this.store.listPhases(projectId),
      tasks: this.store.listTasks({ projectId }),
      updates: [], // only explicitly-approved updates; none are implicit
      generatedAt,
    });

    // Hash the CONTENT, not the render — `generatedAt` changes every call and would
    // otherwise make every preview look like a change.
    const hash = contentHash(JSON.stringify({ ...hub, generatedAt: '' }));
    const row = this.store.getPublication(projectId);
    const published =
      row && !row.revokedAt
        ? { slug: row.publicSlug, publishedAt: row.publishedAt, inSync: row.contentHash === hash }
        : null;

    return { hub, contentHash: hash, published };
  }

  /**
   * Publish the hub (ADR-0045).
   *
   * Consequential and effectively irreversible — a page someone already fetched is
   * out in the world — so it goes through `requestApproval`, which until now had
   * exactly ONE caller in the entire system (real lane runs). This is its second.
   *
   * The bytes are written to disk. The public route serves ONLY those bytes and
   * executes zero SQL, so there is no query for anything to be injected into.
   */
  async publishHub(
    input: { projectId: string; conversationId: string } & EntityWriteOpts,
  ): Promise<{ slug: string; contentHash: string; url: string }> {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error(`no such project: ${input.projectId}`);

    const { hub, contentHash: hash } = this.previewHub(input.projectId);
    if (!hub.goal) {
      throw new Error('conflict: nothing to publish — the project has no goal yet');
    }

    // `requestApproval` returns the DECISION STRING, not a boolean. `if (!decision)`
    // would be false for 'deny' — a truthy string — and a denied publish would have
    // published. Compare explicitly against 'allow' and nothing else.
    const decision = await this.requestApproval(
      { projectId: input.projectId, conversationId: input.conversationId },
      'hub.publish',
      `Publish "${project.name}" publicly. Anyone with the link can read it, and a page already fetched cannot be un-fetched.`,
    );
    if (decision !== 'allow') {
      throw new Error(`conflict: publication was not approved (${decision})`);
    }

    // Reuse the existing slug so the URL is STABLE across republishes — the video's
    // own complaint about Cloudflare Drop was that the URL changed every time.
    const existing = this.store.getPublication(input.projectId);
    const slug = existing?.publicSlug ?? randomBytes(18).toString('base64url');
    if (!SLUG_RE.test(slug)) throw new Error('internal: generated an invalid slug');

    const dir = this.hubDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}.html`), renderPublicHub(hub), 'utf8');

    this.store.publishHub({ ...input, publicSlug: slug, contentHash: hash });
    return { slug, contentHash: hash, url: `/p/${slug}` };
  }

  /**
   * Take it down. The bytes go first; the DB fact and audit trail follow.
   *
   * The public reader executes zero SQL — it serves whatever `<slug>.html` is on
   * disk, so **the file is the only thing a stranger sees**, not `revoked_at`.
   * That makes the unlink the actual takedown, and it must fail CLOSED: only
   * "already gone" counts as removed; any other error (EPERM/EBUSY/EROFS — real on
   * the Windows target when a scanner or the operator's browser holds the file)
   * throws BEFORE the DB is marked revoked, so the operator is never told a page
   * came down while it is still being served.
   */
  revokeHub(
    input: { projectId: string; conversationId: string; reason: string } & EntityWriteOpts,
  ): { ok: true } {
    const row = this.store.getPublication(input.projectId);
    if (!row || row.revokedAt) throw new Error('not found: nothing is published for this project');
    try {
      rmSync(join(this.hubDir(), `${row.publicSlug}.html`));
    } catch (err) {
      // "already gone" is the goal state, not a failure. Anything else means the
      // bytes are still live — refuse to report a takedown that did not happen.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          'conflict: the published page could not be removed from disk, so it is still live — nothing was revoked',
        );
      }
    }
    this.store.revokeHub(input);
    return { ok: true };
  }

  /**
   * Serve a published page (ADR-0045). THE PUBLIC REQUEST PATH.
   *
   * Executes **zero SQL**. It validates the slug against a regex, then reads one
   * file by exact name from one fixed directory. There is no query for anything to
   * be injected into, and no way to reach another project's data with any input.
   */
  readPublishedHub(slug: string): string | null {
    if (!SLUG_RE.test(slug)) return null; // validated BEFORE any path is constructed
    const dir = this.hubDir();
    const file = join(dir, `${slug}.html`);
    // Belt and braces: the resolved path must still be inside the publish dir.
    if (!resolve(file).startsWith(`${resolve(dir)}/`)) return null;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null; // never distinguish "revoked" from "never existed"
    }
  }

  // ── the weekly review (ADR-0045) ───────────────────────────────────────────

  /**
   * Persist the scheduler's run-state (ADR-0045) — a plain, non-secret settings row.
   *
   * Anchored to the `system` project, like every other daemon-level fact. It is
   * settings, not domain state: losing it costs one extra review, not correctness
   * (the packet is idempotent per ISO week regardless).
   */
  putSchedulerState(state: Record<string, unknown>): void {
    const project = this.ensureProject({ slug: 'system', name: 'System' });
    const conversationId = this.defaultConversationFor(project.id);
    this.store.updateSetting({
      projectId: project.id,
      conversationId,
      key: SCHEDULER_STATE_SETTING,
      value: state,
      origin: 'system',
    });
  }

  /** Compute the packet without writing anything — for the UI and for tests. */
  buildReview(projectId: string, now: Date = new Date()): ReviewPacket {
    return buildReviewPacket({
      projectId,
      brief: this.store.getBrief(projectId) ?? null,
      tasks: this.store.listTasks({ projectId }),
      milestones: this.store.listMilestones({ projectId }),
      risks: this.store.listRisks({ projectId }),
      questions: this.store.listQuestions({ projectId }),
      now,
    });
  }

  /**
   * Run the weekly review for one project (ADR-0045).
   *
   * "לא יבצע שינויים בשקט" — it proposes and it summarizes. The ONLY things it is
   * allowed to write are Inbox items (proposals) and one `message.system`. It never
   * closes a task, never moves a date, never publishes.
   *
   * Idempotent per ISO week: the packet key is `review:<project>:<week>`, and a
   * second run in the same week is a no-op. That holds even if the scheduler's
   * run-state is lost, which is the belt to the persisted-state braces.
   *
   * Returns true when there was something worth saying.
   */
  runProjectReview(projectId: string, now: Date = new Date()): boolean {
    const project = this.store.getProject(projectId);
    if (!project?.activatedAt) return false; // a project that never started cannot drift

    const packet = this.buildReview(projectId, now);
    if (packet.empty) return false;

    // Already reviewed this week? Then say nothing again.
    const already = this.store
      .listInboxItems({ projectId })
      .some((i) => i.suggested?.reviewKey === packet.key);
    if (already) return false;

    const conversationId = this.defaultConversationFor(projectId);

    // The recommendations become PROPOSALS — never actions.
    for (const r of packet.recommendations.slice(0, 6)) {
      try {
        this.store.captureInboxItem({
          projectId,
          conversationId,
          origin: 'system',
          text: r,
          rationale: `Weekly review ${packet.weekOf}`,
          confidence: 'medium',
          // The week key rides along so a second run in the same week is a no-op
          // even if the scheduler's run-state was lost.
          suggested: { reviewKey: packet.key },
        });
      } catch {
        // one bad proposal must not lose the packet
      }
    }

    // …and one message the operator actually reads.
    this.store.appendEvent({
      id: newId(),
      ts: now.toISOString(),
      projectId,
      conversationId,
      origin: 'system',
      type: 'message.system',
      payload: { text: renderReviewPacket(packet) },
    } as UnsealedEvent);

    return true;
  }

  /** The project's default conversation — created on demand, never guessed. */
  private defaultConversationFor(projectId: string): string {
    const live = this.store.listConversations(projectId).filter((c) => !c.archivedAt);
    const existing = live[0];
    if (existing) return existing.id;
    return this.store.createConversation({ projectId, title: '(default)' }).id;
  }

  // ── phases + activation (ADR-0045) ─────────────────────────────────────────

  listPhases(projectId: string): PhaseRow[] {
    return this.store.listPhases(projectId);
  }

  createPhase(
    input: {
      projectId: string;
      conversationId: string;
      title: string;
      description?: string;
      status?: MilestoneStatus;
      orderKey?: string;
    } & EntityWriteOpts,
  ): { phaseId: string } {
    return { phaseId: this.store.createPhase(input).phaseId };
  }

  updatePhase(
    input: {
      projectId: string;
      conversationId: string;
      phaseId: string;
      title?: string;
      description?: string | null;
      status?: MilestoneStatus;
      orderKey?: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.updatePhase(input);
    return { ok: true };
  }

  /**
   * ACTIVATE the project (ADR-0045).
   *
   * "כאשר יש מספיק בסיס, אמריטה מציעה להפעיל את הפרויקט. רק אחרי אישור שלך היא
   *  יוצרת אבני דרך, שלבים ומשימות ראשונות."
   *
   * This is what stops Amrita from dumping you into an empty board. Until it is
   * called, the project is a CONVERSATION. It is called only by an explicit
   * operator action, and it is the caller (the UI, having shown the proposal) that
   * supplies the phases/milestones/tasks — Amrita proposes them, the human approves
   * them, and only then do they exist.
   *
   * Refuses to run twice, and refuses to run on a charter with no basis: a board
   * conjured from nothing is exactly what the whole design is against.
   */
  activateProject(
    input: {
      projectId: string;
      conversationId: string;
      // `| undefined` on the nested optionals: `clean()` only strips undefined at the
      // TOP level, and `exactOptionalPropertyTypes` is on — so the zod-parsed shape
      // genuinely carries `description?: string | undefined` inside the arrays.
      phases: { title: string; description?: string | undefined }[];
      milestones?: { title: string; targetDate?: string | undefined }[];
      tasks?: { title: string; phaseIndex?: number | undefined }[];
    } & EntityWriteOpts,
  ): { phaseIds: string[]; milestoneIds: string[]; taskIds: string[] } {
    const project = this.store.getProject(input.projectId);
    if (!project) throw new Error(`no such project: ${input.projectId}`);
    if (project.activatedAt) {
      throw new Error('conflict: this project is already activated');
    }
    const brief = this.store.getBrief(input.projectId) ?? null;
    if (!readyToActivate(brief)) {
      throw new Error(
        'conflict: the charter has no basis yet — a goal, a finish line and at least one constraint are needed before a board can exist',
      );
    }

    const c = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      ...(input.origin ? { origin: input.origin } : {}),
    };

    // Phases first: tasks reference them, and the trigger checks they exist.
    const phaseIds: string[] = [];
    let key = 'n';
    for (const p of input.phases) {
      const { phaseId } = this.store.createPhase({
        ...c,
        title: p.title,
        ...(p.description ? { description: p.description } : {}),
        orderKey: key,
      });
      phaseIds.push(phaseId);
      key = `${key}n`; // monotone, and never terminal — see board.ts's invariant
    }

    const milestoneIds = (input.milestones ?? []).map(
      (m) =>
        this.store.createMilestone({
          ...c,
          title: m.title,
          ...(m.targetDate ? { targetDate: m.targetDate } : {}),
        }).milestoneId,
    );

    const taskIds = (input.tasks ?? []).map((t) => {
      const phaseId = t.phaseIndex !== undefined ? phaseIds[t.phaseIndex] : undefined;
      return this.store.createTask({
        ...c,
        title: t.title,
        // Amrita proposed these and the operator approved them — so they are real,
        // but they are not something the operator said first-hand (ADR-0045).
        certainty: 'inferred',
        ...(phaseId ? { phaseId } : {}),
      }).taskId;
    });

    this.store.activateProject({
      ...c,
      phaseCount: phaseIds.length,
      milestoneCount: milestoneIds.length,
      taskCount: taskIds.length,
    });

    return { phaseIds, milestoneIds, taskIds };
  }

  /**
   * Turn a lane's merge report into Inbox proposals (ADR-0045).
   *
   * A lane is an agent, so its output follows exactly the same rule as the Scribe's:
   * it PROPOSES, a human disposes. Nothing a lane "found" becomes project truth
   * without a triage — that is what keeps a runaway lane from quietly rewriting the
   * plan. Best-effort: a lane must never fail because its bookkeeping did.
   */
  private captureMergeReport(projectId: string, conversationId: string, report: MergeReport): void {
    const propose = (text: string, kind: InboxKind, suggested: Record<string, unknown>): void => {
      try {
        this.store.captureInboxItem({
          projectId,
          conversationId,
          origin: 'lane',
          text,
          suggestedKind: kind,
          suggested,
          rationale: `A lane reported this while working: ${report.summary.slice(0, 200)}`,
          confidence: 'medium',
        });
      } catch {
        // one bad item must not fail the lane
      }
    };

    for (const t of report.tasks ?? []) propose(t, 'task', { title: t });
    for (const d of report.decisions ?? []) propose(d, 'decision', { text: d });
    for (const f of report.followUps ?? []) propose(f, 'task', { title: f });
  }

  // ── the Scribe — the agent→domain bridge (ADR-0044) ────────────────────────

  /**
   * Normalize what a turn established into typed proposals.
   *
   * Everything here is best-effort by design: the reply has already been sent and
   * persisted. A provider failure, a malformed response, a missing role binding —
   * all of them mean "no proposals this turn", never "the turn failed".
   */
  private async runScribe(input: {
    projectId: string;
    conversationId: string;
    userText: string;
    agentText: string;
    sourceMessageId: string;
    contextPack: string;
  }): Promise<void> {
    if (this.getSetting(SCRIBE_SETTING) === false) return;
    // The gate is REQUIRED, not an optimization: the `fast` role can resolve to a
    // CLI subprocess, so an ungated Scribe would spawn a process for "thanks!".
    if (!looksLikeProjectTruth(input.userText, input.agentText)) return;

    let text: string;
    try {
      // Role `fast` by construction — the Scribe is a cheap, mechanical pass and
      // must never burn the `main`/`deep` model that answers the operator.
      const { provider, model } = this.resolveChatProvider(
        { conversationId: input.conversationId, text: '', role: 'fast' },
        input.projectId,
      );
      const resp = await provider.generate({
        messages: [
          {
            role: 'user',
            text: buildScribePrompt({
              contextPack: input.contextPack,
              userText: input.userText,
              agentText: input.agentText,
            }),
          },
        ],
        model,
      });
      text = resp.text;
    } catch {
      return; // no provider, no proposals — never a failed turn
    }

    const proposals = parseScribeResponse(text);
    if (proposals.length === 0) return;

    // The auto-commit boundary (ADR-0044): an open question is INERT — it asserts
    // nothing and is maximally reversible — so it commits directly and the
    // interview flows. Everything that ASSERTS something waits for a human.
    const autoOpen =
      this.getSetting(SCRIBE_AUTO_OPEN_QUESTIONS_SETTING) !== false &&
      this.store.listQuestions({ projectId: input.projectId, status: 'open' }).length <
        MAX_OPEN_QUESTIONS;
    const existing = new Set(
      this.store
        .listQuestions({ projectId: input.projectId, status: 'open' })
        .map((q) => questionKey(q.text)),
    );

    let opened = 0;
    for (const p of proposals) {
      try {
        if (
          p.kind === 'question' &&
          autoOpen &&
          opened < MAX_AUTO_QUESTIONS_PER_TURN &&
          !existing.has(questionKey(p.text))
        ) {
          this.store.openQuestion({
            projectId: input.projectId,
            conversationId: input.conversationId,
            text: p.text,
            sourceMessageId: input.sourceMessageId,
            origin: 'agent',
            // ADR-0045: this is the ONE thing that enters project truth without a
            // human approving it, so it must never look like something you said.
            certainty: 'inferred',
          });
          existing.add(questionKey(p.text));
          opened++;
          continue;
        }

        const { kind, text: itemText, suggested } = suggestedPayload(p);
        this.store.captureInboxItem({
          projectId: input.projectId,
          conversationId: input.conversationId,
          origin: 'agent',
          text: itemText,
          suggestedKind: kind,
          suggested,
          rationale: p.rationale,
          confidence: p.confidence,
          sourceMessageId: input.sourceMessageId,
        });
      } catch {
        // one bad proposal must not lose the rest of the turn's work
      }
    }
  }

  // ── the Inbox — the one triage queue (ADR-0044) ────────────────────────────

  captureInbox(
    input: {
      projectId: string;
      conversationId: string;
      origin: InboxOrigin;
      text: string;
      suggestedKind?: InboxKind;
      suggested?: Record<string, unknown>;
      rationale?: string;
      confidence?: InboxConfidence;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { itemId: string } {
    return { itemId: this.store.captureInboxItem(input).itemId };
  }

  listInbox(filters: { projectId: string; status?: InboxStatus }): InboxItemRow[] {
    return this.store.listInboxItems(filters);
  }

  /**
   * Promote an Inbox item into a REAL aggregate.
   *
   * The promotion goes through the same typed command a human would call — this
   * is what stops the Inbox from becoming a second, weaker write path into the
   * domain. Only once the aggregate exists do we record what the item became.
   *
   * Not one transaction (each is its own `appendEvent`), and that asymmetry is
   * deliberate: if the promotion succeeds but the bookkeeping throws, the worst
   * case is an item that stays `pending` while its task exists — visible, and
   * re-triageable. The reverse (an item marked triaged with nothing behind it)
   * is the one that would be a lie, and the SQL CHECK makes it impossible.
   */
  triageInbox(
    input: { projectId: string; conversationId: string; itemId: string } & TriageTarget &
      EntityWriteOpts,
  ): { promotedKind: InboxKind; promotedId: string } {
    const item = this.store.getInboxItem(input.itemId);
    if (!item) throw new Error(`no such inbox item: ${input.itemId}`);
    if (item.status !== 'pending') {
      throw new Error(`inbox item is already ${item.status}`);
    }
    const c = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      ...(input.origin ? { origin: input.origin } : {}),
      // provenance survives the promotion: the task/risk/decision points back at
      // the message that produced the proposal in the first place
      ...(item.sourceMessageId ? { sourceMessageId: item.sourceMessageId } : {}),
    };
    // ADR-0045: certainty follows WHO raised it. A human capture is something you
    // stated; anything an agent or a lane worked out stays marked as INFERRED even
    // after you approve it — approval makes it actionable, not first-hand.
    const certainty: Certainty = item.origin === 'user' ? 'stated' : 'inferred';

    let promotedId: string;
    switch (input.kind) {
      case 'task':
        promotedId = this.store.createTask({
          ...c,
          certainty,
          title: input.title,
          ...(input.body ? { body: input.body } : {}),
          ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
        }).taskId;
        break;
      case 'decision':
        promotedId = this.store.recordDecision({ ...c, text: input.text }).decisionId;
        break;
      case 'risk':
        promotedId = this.store.openRisk({
          ...c,
          certainty,
          text: input.text,
          ...(input.severity ? { severity: input.severity } : {}),
        }).riskId;
        break;
      case 'question':
        promotedId = this.store.openQuestion({ ...c, certainty, text: input.text }).questionId;
        break;
      case 'milestone':
        promotedId = this.store.createMilestone({
          ...c,
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          ...(input.targetDate ? { targetDate: input.targetDate } : {}),
        }).milestoneId;
        break;
      case 'memory':
        promotedId = this.store.putMemoryEntry({
          ...c,
          scope: 'project',
          content: input.content,
          source: 'inbox',
        }).entryId;
        break;
    }

    this.store.triageInboxItem({
      projectId: input.projectId,
      conversationId: input.conversationId,
      itemId: input.itemId,
      promotedKind: input.kind,
      promotedId,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    return { promotedKind: input.kind, promotedId };
  }

  dismissInbox(
    input: {
      projectId: string;
      conversationId: string;
      itemId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    const item = this.store.getInboxItem(input.itemId);
    if (!item) throw new Error(`no such inbox item: ${input.itemId}`);
    this.store.dismissInboxItem(input);
    return { ok: true };
  }

  // ── organizational brain harness (ADR-0027) ────────────────────────────────

  /** The harness agent topology (honest about active vs planned agents). */
  harnessTopology(): HarnessTopology {
    return HARNESS_TOPOLOGY;
  }

  /** Ingestion sources with honest status; chat is enriched from the live
   *  runner, and the Cinema module source is `connected` only when the given
   *  project actually holds cinema-synced data (ADR-0030). */
  listKnowledgeSources(projectId?: string): KnowledgeSource[] {
    const telegramLive = this.isChannelRunnerActive('telegram');
    const cinemaHasData = projectId
      ? this.store
          .listMemoryEntries(projectId)
          .some((e) => (e.source ?? '').toLowerCase() === 'module:cinema')
      : false;
    return [
      ...baseKnowledgeSources().map((s) =>
        s.id === 'chat' && telegramLive
          ? {
              ...s,
              detail: `${s.detail} (Telegram runner is live now)`,
            }
          : s,
      ),
      cinemaKnowledgeSource(cinemaHasData),
    ];
  }

  /**
   * The Planner (ADR-0048) — the sibling of the Scribe. It turns a BUILD/RESEARCH
   * request into a delegated execution session, so Amrita supervises instead of
   * writing code in chat. Gated three ways: the kill-switch (default ON), a cheap
   * intent gate (only delegatable build/research), and a working folder (no root ⇒
   * no session; Amrita's reply already says so). If no coding runtime is ready it
   * opens NOTHING and stays honest. `startLane` is the single spawn path — it mints
   * the laneId, jails the workspace (ADR-0039) and gates real execution on operator
   * approval (ADR-0021); `detach` so this never blocks the already-sent reply.
   */
  private async runPlanner(input: {
    projectId: string;
    conversationId: string;
    userText: string;
  }): Promise<void> {
    if (this.getSetting(ORCHESTRATION_SETTING) === false) return;
    if (!looksLikeBuildIntent(input.userText)) return;

    const { intent } = classifyIntent(input.userText);
    const runtimes = await this.getCodingRuntimes();
    const agent = resolveAgent({ intent, runtimes, realExecution: this.realLaneExecution });
    if (agent.kind === 'human') return; // no ready runtime → Amrita's reply says so honestly

    // Open an INTERACTIVE, streamed tmux session (ADR-0049) so the operator WATCHES the
    // agent build live in the Claude/Codex tab — not a silent headless lane. It is
    // gated by the Approval Constitution (interactive-session → material → the operator
    // approves and attends) and jailed to a synthesized workspace, so it needs no bound
    // project root. Unattended autonomous building still uses headless (delegateTask).
    const kind = agent.kind === 'codex' ? 'codex-tmux' : 'claude-code-tmux';
    const mandate = buildMandateFromChat({
      laneId: newId(),
      requestText: input.userText,
      brief: this.store.getBrief(input.projectId) ?? null,
      memory: this.store.listMemoryEntries(input.projectId),
      decisions: this.store.listDecisions({ projectId: input.projectId }),
      budget: { maxMinutes: 30 },
    });

    await this.startLane({
      conversationId: input.conversationId,
      goal: mandate.goal,
      kind,
      contextPack: mandate.contextPack,
      budget: mandate.budget,
      approvals: mandate.approvals,
      detach: true,
    });
  }

  /**
   * Derive the maintained Project Brain — normalized records (with provenance
   * and links), gaps, maintenance timeline, counts. A deterministic projection
   * over event-sourced state + manually-captured memory (no new storage).
   */
  /**
   * The Project Context Pack for a chat turn (ADR-0044) — the live project state
   * the model is given as a system message. `''` when the project has nothing
   * worth saying yet (a brand-new project), in which case the caller sends no
   * system message at all.
   *
   * No cache, by design: rebuilt from the store every turn, so a task the user
   * just dragged is in the very next turn's context with no invalidation step.
   *
   * Settings-gated (`context.pack.enabled`, default ON) so a bad pack degrades to
   * exactly the old behavior — transcript only — rather than breaking chat.
   */
  async buildContextPack(projectId: string): Promise<string> {
    if (this.getSetting(CONTEXT_PACK_SETTING) === false) return '';
    const project = this.store.getProject(projectId);
    if (!project) return '';

    // The working tree probe spawns `git` and can fail on a bad root; a chat turn
    // must never die because of it.
    let context: ProjectContextWire | null = null;
    try {
      context = await this.getProjectContext(projectId);
    } catch {
      context = null;
    }

    const brain = this.getProjectBrain(projectId);
    const brief = this.store.getBrief(projectId) ?? null;
    const tasks = this.store.listTasks({ projectId });
    const risks = this.store.listRisks({ projectId });
    const questions = this.store.listQuestions({ projectId });
    // ADR-0051: the manager can SEE her active sessions. Gated with orchestration
    // and failure-tolerant — a tmux probe must never fail (or stall) a chat turn.
    let sessions: SessionBrief[] = [];
    if (this.getSetting(ORCHESTRATION_SETTING) !== false) {
      try {
        sessions = await this.collectSessionBriefs(projectId);
      } catch {
        sessions = [];
      }
    }
    const pack = buildProjectContextPack({
      project: { name: project.name },
      brief,
      charterFindings: auditCharter({ brief, tasks, risks, questions }),
      tasks,
      milestones: this.store.listMilestones({ projectId }),
      questions,
      risks,
      decisions: this.store.listDecisions({ projectId }),
      memory: this.store.listMemoryEntries(projectId),
      gaps: brain.gaps,
      sources: brain.sources,
      context,
      sessions,
    });
    // The preamble is a property of Amrita, not the project, so it goes on EVERY
    // turn. When orchestration is on (default), she delegates builds to a session
    // (AMRITA_ORCHESTRATOR); the kill-switch reverts to the legacy inline canvas.
    const preamble =
      this.getSetting(ORCHESTRATION_SETTING) === false ? AMRITA_CAPABILITIES : AMRITA_ORCHESTRATOR;
    return pack ? `${preamble}\n\n${pack}` : preamble;
  }

  /**
   * Bounded, redacted briefs of this project's ACTIVE interactive sessions
   * (ADR-0051) — the eyes of the chat brain. DERIVED per turn from
   * `getSessionSnapshot` (the single runtime-state authority); nothing here is
   * stored, and a probe failure degrades to "no brief", never a failed turn.
   * Index is newest-first and matches what the relay seam resolves ("סשן 2").
   */
  private async collectSessionBriefs(projectId: string): Promise<SessionBrief[]> {
    const lanes = this.store
      .listLanes({ projectId })
      .filter((l) => l.kind.endsWith('-tmux') && l.status !== 'completed' && l.status !== 'aborted')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
    const briefs: SessionBrief[] = [];
    for (const [i, lane] of lanes.entries()) {
      try {
        const snap = await this.getSessionSnapshot(projectId, lane.id);
        let goal = 'unknown goal';
        try {
          goal = laneMandateSchema.parse(JSON.parse(lane.mandateJson)).goal;
        } catch {
          /* malformed history — keep the honest placeholder */
        }
        const screenTail = snap.live
          ? snap.text
              .split('\n')
              .map((l) => l.replace(/\s+$/, ''))
              .filter((l) => l.trim().length > 0)
              .slice(-8)
          : [];
        briefs.push({
          index: i + 1,
          agent: lane.kind === 'codex-tmux' ? 'codex' : 'claude',
          state: snap.state,
          goal,
          screenTail,
        });
      } catch {
        /* a dead/foreign/raced lane simply has no brief */
      }
    }
    return briefs;
  }

  /**
   * The RELAY seam (ADR-0051) — the Planner's sibling on the INPUT side. Runs
   * BEFORE the provider call, so the reply can truthfully confirm what was (or
   * was not) typed into the session. Deterministic, conservative, and enforced
   * by the same guarded `sendSessionInput` path (never types into login/trust/
   * blocked/dead screens). Returns a value-free note for the system message, or
   * null when the message is not a relay.
   */
  private async runRelay(
    projectId: string,
    conversationId: string,
    userText: string,
  ): Promise<string | null> {
    if (this.getSetting(ORCHESTRATION_SETTING) === false) return null;
    const verdict = classifyRelay(userText);
    if (!verdict) return null;

    const candidates = this.store
      .listLanes({ projectId })
      .filter((l) => l.kind.endsWith('-tmux') && l.status !== 'completed' && l.status !== 'aborted')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (candidates.length === 0) {
      return 'SESSION RELAY: the operator asked to send input, but this project has no active session — say so and offer to open one.';
    }
    const target = verdict.session ? candidates[verdict.session - 1] : candidates[0];
    if (!target) {
      return `SESSION RELAY: the operator named session ${verdict.session}, but only ${candidates.length} session(s) are active — ask which one they meant.`;
    }
    if (!verdict.session && candidates.length > 1) {
      return `SESSION RELAY: ${candidates.length} sessions are active and the operator did not say which — nothing was sent; ask them to name one (e.g. "בסשן 1").`;
    }

    const label = verdict.kind === 'option' ? `option ${verdict.value}` : 'the requested text';
    try {
      const res = await this.sendSessionInput(projectId, target.id, verdict.value);
      if (!res.sent) {
        return `SESSION RELAY: could not send ${label} — the session is no longer available. Say so honestly.`;
      }
      // Audit trail: a coarse, value-free progress note on the lane's own log.
      this.safeEmitLane(projectId, target.conversationId, target.id, 'lane.progress', {
        note: 'operator input relayed from chat',
      });
      return `SESSION RELAY: ${label} was JUST typed into session ${verdict.session ?? 1} (${target.kind === 'codex-tmux' ? 'codex' : 'claude'}) and submitted. Confirm this to the operator; the session screen will update shortly.`;
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'the session refused the input';
      return `SESSION RELAY: NOT sent — ${reason}. Explain this honestly and tell the operator what to do next.`;
    }
  }

  getProjectBrain(projectId: string, now: string = new Date().toISOString()): ProjectBrain {
    return buildProjectBrain({
      projectId,
      now,
      brief: this.store.getBrief(projectId) ?? null,
      decisions: this.store.listDecisions({ projectId }),
      questions: this.store.listQuestions({ projectId }),
      risks: this.store.listRisks({ projectId }),
      milestones: this.store.listMilestones({ projectId }),
      tasks: this.store.listTasks({ projectId }),
      memory: this.store.listMemoryEntries(projectId),
      timeline: this.store.listProjectEvents(projectId, { limit: 80 }),
      sources: this.listKnowledgeSources(projectId),
    });
  }

  /**
   * Manual capture into the brain (the capture-agent). Writes a structured
   * memory entry the projection normalizes into a record with provenance.
   * Secret-free by construction — goes through the value-free memory path.
   */
  captureKnowledge(
    input: {
      projectId: string;
      conversationId: string;
      kind?: ProjectBrain['records'][number]['kind'];
      title: string;
      body?: string;
      owner?: string;
      date?: string;
      tags?: string[];
      source?: string;
    } & EntityWriteOpts,
  ): { entryId: string; kind: string } {
    const kind = input.kind ?? 'project-context';
    const markerPrefix: Record<string, string> = {
      decision: 'decision: ',
      commitment: 'commitment: ',
      'meeting-note': 'meeting: ',
      entity: 'entity: ',
      'project-context': '',
      'open-question': '',
      'source-excerpt': '',
    };
    let head = `${markerPrefix[kind] ?? ''}${input.title}`;
    if (input.owner) head += ` @${input.owner}`;
    if (input.date) head += ` due:${input.date}`;
    const tagStr = (input.tags ?? []).map((t) => `#${t}`).join(' ');
    const content = [head, input.body, tagStr].filter((p) => p && p.length > 0).join('\n\n');
    const { entryId } = this.store.putMemoryEntry({
      projectId: input.projectId,
      conversationId: input.conversationId,
      scope: 'project',
      content,
      source: input.source ?? 'manual:brain',
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    });
    return { entryId, kind };
  }

  upsertBrand(
    input: {
      projectId: string;
      conversationId: string;
      name?: string;
      audience?: string;
      tone?: string;
      styleNotes?: string[];
      palette?: string[];
      typography?: string;
      doNotUse?: string[];
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.upsertBrand(input);
    return { ok: true };
  }

  approvePreview(
    input: {
      projectId: string;
      conversationId: string;
      previewId: string;
      contentHash: string;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.approvePreview(input);
    return { ok: true };
  }

  upsertBrief(
    input: {
      projectId: string;
      conversationId: string;
      goal: string;
      audience?: string;
      successCriteria?: string[];
      scope?: string[];
      noScope?: string[];
      // the charter (ADR-0044)
      finishLine?: string;
      constraints?: ProjectConstraint[];
      decisionRights?: DecisionRight[];
      certainty?: Record<string, Certainty>;
      sourceMessageId?: string;
      /** ADR-0045: a stale full-document brief write would WIPE the charter. */
      expectedVersion?: number;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.upsertBrief(input);
    return { ok: true };
  }

  openQuestion(
    input: {
      projectId: string;
      conversationId: string;
      text: string;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { questionId: string } {
    return { questionId: this.store.openQuestion(input).questionId };
  }

  resolveQuestion(
    input: {
      projectId: string;
      conversationId: string;
      questionId: string;
      resolution?: string;
      resolvedByDecisionId?: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.resolveQuestion(input);
    return { ok: true };
  }

  dropQuestion(
    input: {
      projectId: string;
      conversationId: string;
      questionId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.dropQuestion(input);
    return { ok: true };
  }

  listQuestions(filters: { projectId?: string; status?: QuestionStatus }): OpenQuestionRow[] {
    return this.store.listQuestions(filters);
  }

  openRisk(
    input: {
      projectId: string;
      conversationId: string;
      text: string;
      severity?: RiskSeverity;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { riskId: string } {
    return { riskId: this.store.openRisk(input).riskId };
  }

  resolveRisk(
    input: {
      projectId: string;
      conversationId: string;
      riskId: string;
      resolution?: string;
      resolvedByDecisionId?: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.resolveRisk(input);
    return { ok: true };
  }

  dropRisk(
    input: {
      projectId: string;
      conversationId: string;
      riskId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.dropRisk(input);
    return { ok: true };
  }

  listRisks(filters: { projectId?: string; status?: QuestionStatus }): RiskRow[] {
    return this.store.listRisks(filters);
  }

  createMilestone(
    input: {
      projectId: string;
      conversationId: string;
      title: string;
      description?: string;
      targetDate?: string;
      status?: MilestoneStatus;
    } & EntityWriteOpts,
  ): { milestoneId: string } {
    return { milestoneId: this.store.createMilestone(input).milestoneId };
  }

  updateMilestone(
    input: {
      projectId: string;
      conversationId: string;
      milestoneId: string;
      title?: string;
      description?: string;
      status?: MilestoneStatus;
      targetDate?: string | null;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.updateMilestone(input);
    return { ok: true };
  }

  completeMilestone(
    input: { projectId: string; conversationId: string; milestoneId: string } & EntityWriteOpts,
  ): { ok: true } {
    this.store.completeMilestone(input);
    return { ok: true };
  }

  listMilestones(filters: { projectId?: string; status?: MilestoneStatus }): MilestoneRow[] {
    return this.store.listMilestones(filters);
  }

  /** The derived project timeline (bounded, newest first) — ADR-0018. */
  listProjectEvents(projectId: string, limit?: number): AmritaEvent[] {
    return this.store.listProjectEvents(projectId, limit !== undefined ? { limit } : {});
  }

  // ── decisions ─────────────────────────────────────────────────────────────

  recordDecision(
    input: { projectId: string; conversationId: string; text: string } & EntityWriteOpts,
  ): { decisionId: string } {
    return { decisionId: this.store.recordDecision(input).decisionId };
  }

  listDecisions(filters: {
    projectId?: string;
    conversationId?: string;
    includeSuperseded?: boolean;
  }): DecisionRow[] {
    return this.store.listDecisions(filters);
  }

  // ── memory ──────────────────────────────────────────────────────────────────

  // ── cinema mandates (ADR-0029; module: cinema-mandates.ts since R2) ───────

  issueCinemaMandate(input: {
    projectId: string;
    conversationId: string;
    goal: string;
    allowedVerbs?: string[];
    maxRisk?: 'local' | 'credit' | 'destructive' | 'ambiguous';
    note?: string;
  }): { mandateId: string } {
    return issueCinemaMandate(this.store, input);
  }

  listCinemaMandates(
    conversationId: string,
    openOnly = false,
  ): { mandate: CinemaMandate; status: 'open' | 'resolved'; report?: CinemaMandateReport }[] {
    return listCinemaMandates(this.store, conversationId, openOnly);
  }

  completeCinemaMandate(input: {
    projectId: string;
    conversationId: string;
    report: unknown;
  }): { ok: true } | { ok: false; reason: 'not-found' | 'already-resolved' } {
    return completeCinemaMandate(this.store, input);
  }

  putMemoryEntry(
    input: {
      projectId: string;
      conversationId: string;
      scope: MemoryScope;
      content: string;
      entryId?: string;
      source?: string;
    } & EntityWriteOpts,
  ): { entryId: string } {
    return { entryId: this.store.putMemoryEntry(input).entryId };
  }

  searchMemory(
    query: string,
    opts: { scope?: MemoryScope; projectId?: string; limit?: number },
  ): MemoryEntryRow[] {
    return this.store.searchMemory(query, opts);
  }

  // ── settings ────────────────────────────────────────────────────────────────

  updateSetting(
    input: {
      projectId: string;
      conversationId: string;
      key: string;
      value?: unknown;
    } & EntityWriteOpts,
  ): { ok: true } {
    this.store.updateSetting({ ...clean(input), value: input.value });
    return { ok: true };
  }

  getSetting(key: string): unknown {
    return this.store.getSetting(key) ?? null;
  }

  // ── accounts / connectors / lanes ────────────────────────────────────────────

  connectProviderAccount(
    input: {
      projectId: string;
      conversationId: string;
      provider: string;
      authMode: AuthMode;
      label?: string;
    } & EntityWriteOpts,
  ): { accountId: string } {
    return { accountId: this.store.connectProviderAccount(input).accountId };
  }

  listAccounts(): AccountRow[] {
    return this.store.listAccounts();
  }

  /** Bind an account to an env-var NAME (validated; never a secret value). */
  bindAccountSecretRef(accountId: string, envName: string): { ok: true } {
    this.store.bindAccountSecretRef(accountId, envName);
    return { ok: true };
  }

  getProviderConfigStatus(accountId: string): ProviderConfigStatus | null {
    return this.store.getProviderConfigStatus(accountId) ?? null;
  }

  listConnectors(): ConnectorRow[] {
    return this.store.listConnectors();
  }

  /** Live connector states (ADR-0022). Probes run through the injected fetch. */
  connectorStatus(): Promise<ConnectorStatusReport[]> {
    return connectorStatuses(this.fetchImpl);
  }

  /**
   * One-way GitHub issues → tasks import (ADR-0022). Idempotent: issues whose
   * `externalRef` already exists in the project are skipped, and the partial
   * unique index backs that up at the database level. Never writes to GitHub.
   */
  async importGithubIssues(
    input: {
      projectId: string;
      conversationId: string;
      repo: string;
      state?: 'open' | 'all';
      limit?: number;
    } & EntityWriteOpts,
  ): Promise<{
    repo: string;
    imported: number;
    skipped: number;
    total: number;
    tasks: { taskId: string; externalRef: string; title: string }[];
  }> {
    const issues = await fetchGithubIssues(this.fetchImpl, {
      repo: input.repo,
      ...(input.state ? { state: input.state } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    const existing = this.store.listTaskExternalRefs(input.projectId);
    const created: { taskId: string; externalRef: string; title: string }[] = [];
    let skipped = 0;
    for (const issue of issues) {
      const externalRef = `github:${input.repo}#${issue.number}`;
      if (existing.has(externalRef)) {
        skipped++;
        continue;
      }
      const title = `#${issue.number} · ${issue.title}`;
      const { taskId } = this.store.createTask({
        projectId: input.projectId,
        conversationId: input.conversationId,
        title,
        body: `Imported from ${issue.url}`,
        externalRef,
        // ADR-0045: it came from an external system, not from you and not from a guess.
        certainty: 'documented',
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.channel ? { channel: input.channel } : {}),
      });
      created.push({ taskId, externalRef, title });
    }
    return {
      repo: input.repo,
      imported: created.length,
      skipped,
      total: issues.length,
      tasks: created,
    };
  }

  listLanes(filters: {
    projectId?: string;
    conversationId?: string;
    status?: LaneStatus;
  }): LaneRow[] {
    return this.store.listLanes(filters);
  }

  /** Mint (or renew) the workspace view ticket for one lane (6h TTL). */
  issueWorkspaceTicket(laneId: string): { ticket: string; expiresAt: string } {
    if (!this.store.getLane(laneId)) throw new Error(`no such lane: ${laneId}`);
    const now = Date.now();
    // Sweep expired tickets on each mint so the map cannot grow without bound over
    // the daemon's lifetime (one ticket per lane view, never cleaned before).
    for (const [id, entry] of this.workspaceTickets) {
      if (now > entry.expiresAt) this.workspaceTickets.delete(id);
    }
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = now + 6 * 60 * 60 * 1000;
    this.workspaceTickets.set(laneId, { ticket, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Constant-time check of a workspace ticket for THIS lane only. */
  checkWorkspaceTicket(laneId: string, provided: string): boolean {
    const entry = this.workspaceTickets.get(laneId);
    if (!entry || Date.now() > entry.expiresAt) return false;
    const a = Buffer.from(entry.ticket);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  getLane(laneId: string): LaneRow | undefined {
    return this.store.getLane(laneId);
  }

  /**
   * Capture the current interactive pane on demand (ADR-0050). This is a
   * read-only runtime probe: the redacted snapshot is bounded and is never
   * appended to the event log or stored in the lane projection.
   */
  async getSessionSnapshot(projectId: string, laneId: string): Promise<SessionSnapshotWire> {
    const lane = this.store.getLane(laneId);
    // Project scope is part of the lookup, not a post-read UI filter. Return the same
    // absence error for missing and foreign lanes so no project can probe another.
    if (!lane || lane.projectId !== projectId) throw new Error(`no such lane: ${laneId}`);
    if (!lane.kind.endsWith('-tmux')) {
      throw new Error(`conflict: lane ${laneId} is not an interactive session`);
    }

    const capturedAt = new Date().toISOString();
    if (lane.status === 'completed' || lane.status === 'aborted') {
      return {
        laneId,
        live: false,
        state: lane.status,
        text: '',
        capturedAt,
      };
    }

    const pendingApproval = [...this.pendingApprovals.values()].some(
      ({ info }) => info.laneId === laneId,
    );
    const entry = this.activeLanes.get(laneId);
    const name = `amrita-${laneId}`;
    const tmuxState = await this.tmux.sessionState(name);
    const expectedAgent = lane.kind === 'codex-tmux' ? 'codex' : 'claude';
    let expectedCwd: string | null = null;
    try {
      const mandate = laneMandateSchema.parse(JSON.parse(lane.mandateJson));
      expectedCwd = mandate.scope.paths?.[0] ?? null;
    } catch {
      expectedCwd = null;
    }
    const live =
      tmuxState.exists &&
      !tmuxState.dead &&
      tmuxState.agent === expectedAgent &&
      tmuxState.cwd !== null &&
      expectedCwd !== null &&
      resolve(tmuxState.cwd) === resolve(expectedCwd);
    if (!live) {
      const state: SessionRuntimeState = pendingApproval
        ? 'awaiting-approval'
        : entry
          ? 'starting'
          : 'unavailable';
      return { laneId, live: false, state, text: '', capturedAt };
    }

    let raw: string;
    let visible: string;
    try {
      raw = await this.tmux.capturePane(name, 500);
      // Lifecycle classification reads the VISIBLE SCREEN only: a non-clearing TUI
      // (Codex) keeps its answered trust dialog in scrollback, and classifying the
      // history tail would report `starting` forever (found live, 2026-07-16).
      visible = await this.tmux.capturePane(name, 0);
    } catch {
      return { laneId, live: true, state: 'unavailable', text: '', capturedAt };
    }
    // Redact BEFORE truncation so a credential crossing the size boundary cannot
    // survive as an unclassified fragment. Keep the tail, which is the current TUI.
    const text = redactPane(raw).slice(-64_000);
    let state: SessionRuntimeState;
    if (entry?.finishController?.signal.aborted) state = 'finishing';
    else {
      const boot = classifyBootPane(redactPane(visible));
      const goalSent = tmuxState.goalSent || this.sessionGoalWasSent(lane.conversationId, laneId);
      if (boot === 'login') state = 'awaiting-auth';
      else if (boot === 'prompt' || boot === 'blocked' || text.trim().length === 0 || !goalSent) {
        state = 'starting';
      } else state = 'running';
    }
    return { laneId, live: true, state, text, capturedAt };
  }

  /**
   * The Conclusion Capsule for a conversation (ADR-0048) — the derived view Amrita
   * shows instead of code and logs. Read-only: assembled fresh from the lanes, their
   * merge reports, the lane-origin Inbox proposals and pending approvals. It never
   * writes and never becomes an event (a stealth write path is forbidden).
   */
  getConclusionCapsule(conversationId: string): ConclusionCapsule {
    const conv = this.store.getConversation(conversationId);
    const lanes: CapsuleLane[] = this.store.listLanes({ conversationId }).map((row) => {
      let goal = '';
      try {
        goal = (JSON.parse(row.mandateJson) as { goal?: string }).goal ?? '';
      } catch {
        goal = '';
      }
      const report = row.mergeJson
        ? (JSON.parse(row.mergeJson) as {
            exit?: LaneExit;
            summary?: string;
            decisions?: string[];
            followUps?: string[];
            tasks?: string[];
          })
        : null;
      return {
        laneId: row.id,
        kind: row.kind,
        status: row.status,
        goal,
        ...(report?.exit ? { exit: report.exit } : {}),
        ...(report?.summary ? { summary: report.summary } : {}),
        decisions: report?.decisions ?? [],
        followUps: report?.followUps ?? [],
        tasks: report?.tasks ?? [],
      };
    });

    const inbox = conv
      ? this.store
          .listInboxItems({ projectId: conv.projectId, status: 'pending' })
          .filter(
            (i) =>
              i.origin === 'lane' &&
              (i.conversationId === conversationId || i.conversationId === null),
          )
          .map((i) => ({ id: i.id, text: i.text, suggestedKind: i.suggestedKind }))
      : [];

    const approvals = this.listPendingApprovals()
      .filter((a) => a.conversationId === conversationId)
      .map((a) => ({
        approvalId: a.approvalId,
        action: a.action,
        ...(a.laneId ? { laneId: a.laneId } : {}),
      }));

    return buildConclusionCapsule({ conversationId, lanes, inbox, approvals });
  }

  /**
   * Reconcile lanes orphaned by a crash (ADR-0048). `activeLanes` is in-memory, so at
   * boot it is EMPTY by construction — therefore every lane row still in a non-terminal
   * status (spawned/running/merging) is definitionally orphaned: its runner died with
   * the previous process and can never resolve. Left alone the row lies "running"
   * forever. Each is terminalized honestly with `lane.aborted` + `origin:'system'`
   * (reusing the existing event — no new type, no CHECK-widening table rebuild),
   * through `appendEvent` (the single write path), never a raw SQL update. The
   * `activeLanes` guard makes this safe to call again as a manual reap.
   *
   * (Slice 6/ADR-0049 upgrades this: a tmux session still alive is RE-ATTACHED rather
   * than aborted, because it outlives the daemon.)
   */
  reconcileLanesOnBoot(): { reconciled: number } {
    // Only `running`/`merging` represent genuinely orphaned IN-FLIGHT execution. A
    // `spawned` row is ambiguous — it is also the resting state of a completed
    // dry-run, and of a lane that crashed before it ever executed — so aborting it
    // would clobber a legitimate dry-run. Leave `spawned` alone; reap only work that
    // was actually running when the process died.
    const NON_TERMINAL = ['running', 'merging'] as const;
    let reconciled = 0;
    for (const status of NON_TERMINAL) {
      for (const lane of this.store.listLanes({ status })) {
        if (this.activeLanes.has(lane.id)) continue; // live in THIS process — skip
        // A tmux session may still be ALIVE (it outlives the daemon), so it is not
        // orphaned by definition — `resumeTmuxSessions()` re-attaches or aborts it
        // after an async `has-session` check. Leave it here.
        if (lane.kind.endsWith('-tmux')) continue;
        this.store.appendEvent({
          id: newId(),
          ts: new Date().toISOString(),
          projectId: lane.projectId,
          conversationId: lane.conversationId,
          laneId: lane.id,
          origin: 'system',
          type: 'lane.aborted',
          payload: { laneId: lane.id, reason: 'daemon restarted mid-run — lane orphaned' },
        } as UnsealedEvent);
        reconciled++;
      }
    }
    return { reconciled };
  }

  /**
   * Re-attach to interactive tmux sessions after a restart (ADR-0049) — the durability
   * payoff a headless lane cannot have. For each non-terminal `*-tmux` lane: if the
   * tmux session is still alive, re-run its runner (which `has-session` → re-attaches
   * and resumes capture, without re-approving); if it is gone, terminalize it honestly
   * with `lane.aborted` + `origin:'system'`. Async, so `amritad` awaits it after open.
   */
  async resumeTmuxSessions(): Promise<{ resumed: number; aborted: number }> {
    let resumed = 0;
    let aborted = 0;
    for (const status of ['spawned', 'running', 'merging'] as const) {
      for (const lane of this.store.listLanes({ status })) {
        if (!lane.kind.endsWith('-tmux') || this.activeLanes.has(lane.id)) continue;
        if (await this.tmux.hasSession(`amrita-${lane.id}`)) {
          this.resumeLane(lane);
          resumed++;
        } else if (status !== 'spawned') {
          // A spawned row may be an intentional dry-run and never had a process.
          // Running/merging rows, however, are lying unless their tmux survived.
          this.store.appendEvent({
            id: newId(),
            ts: new Date().toISOString(),
            projectId: lane.projectId,
            conversationId: lane.conversationId,
            laneId: lane.id,
            origin: 'system',
            type: 'lane.aborted',
            payload: { laneId: lane.id, reason: 'session did not survive the daemon restart' },
          } as UnsealedEvent);
          aborted++;
        }
      }
    }
    return { resumed, aborted };
  }

  /** Re-run a durable lane's runner against its persisted mandate (no re-approval). */
  private resumeLane(lane: LaneRow): void {
    const runner = this.laneRunnerFor(lane.kind);
    if (!runner) return;
    let mandate: Parameters<LaneRunner['run']>[0];
    try {
      mandate = laneMandateSchema.parse(JSON.parse(lane.mandateJson));
    } catch {
      return;
    }
    const controller = new AbortController();
    const finishController = new AbortController();
    const sessionGoalAlreadySent = this.sessionGoalWasSent(lane.conversationId, lane.id);
    const promise = this.runLaneToCompletion(
      lane.projectId,
      lane.conversationId,
      lane.id,
      mandate,
      runner,
      controller.signal,
      false, // already approved on first start
      finishController.signal,
      sessionGoalAlreadySent,
    ).finally(() => this.activeLanes.delete(lane.id));
    this.activeLanes.set(lane.id, { controller, promise, durable: true, finishController });
  }

  /** Append a lane lifecycle event (laneId on the envelope, so the projection keys on it). */
  private emitLaneEvent(
    projectId: string,
    conversationId: string,
    laneId: string,
    type: string,
    payload: unknown,
  ): AmritaEvent {
    return this.store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      laneId,
      origin: 'lane',
      type,
      payload,
    } as UnsealedEvent);
  }

  /** Emit a lane event, no-op after close, never throwing into the run path. */
  private safeEmitLane(
    projectId: string,
    conversationId: string,
    laneId: string,
    type: string,
    payload: unknown,
  ): void {
    if (this.closed) return;
    try {
      this.emitLaneEvent(projectId, conversationId, laneId, type, payload);
    } catch {
      // a projection hiccup (or a closing store) must never break a lane run
    }
  }

  // ── operator approvals (ADR-0021) ──────────────────────────────────────────

  /**
   * Request an operator approval: emits `approval.requested`, then waits for
   * `resolveApproval` (web/Telegram/CLI), a timeout (→ DENY, audited), or the
   * provided abort signal. Deny-by-default: only an explicit `allow` proceeds.
   */
  requestApproval(
    ctx: { projectId: string; conversationId: string; laneId?: string },
    action: string,
    detail?: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<'allow' | 'deny' | 'timeout'> {
    const approvalId = newId();
    const info: PendingApproval = {
      approvalId,
      action,
      ...(detail ? { detail } : {}),
      projectId: ctx.projectId,
      conversationId: ctx.conversationId,
      ...(ctx.laneId ? { laneId: ctx.laneId } : {}),
      requestedAt: new Date().toISOString(),
    };
    this.store.appendEvent({
      id: newId(),
      ts: info.requestedAt,
      projectId: ctx.projectId,
      conversationId: ctx.conversationId,
      ...(ctx.laneId ? { laneId: ctx.laneId } : {}),
      origin: 'agent',
      type: 'approval.requested',
      payload: { approvalId, action, ...(detail ? { detail } : {}) },
    } as UnsealedEvent);

    return new Promise((resolve) => {
      const timeoutMs = opts.timeoutMs ?? this.approvalTimeoutMs;
      const timer = setTimeout(() => settle('timeout'), timeoutMs);
      const onAbort = () => settle('deny');
      const settle = (decision: 'allow' | 'deny' | 'timeout') => {
        if (!this.pendingApprovals.has(approvalId)) return;
        this.pendingApprovals.delete(approvalId);
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        // Audit the outcome unless the kernel is closing. Timeout audits as deny.
        if (!this.closed && decision !== 'allow') {
          this.safeEmitApprovalResolved(ctx, approvalId, 'deny');
        }
        if (!this.closed && decision === 'allow') {
          this.safeEmitApprovalResolved(ctx, approvalId, 'allow');
        }
        resolve(decision);
      };
      this.pendingApprovals.set(approvalId, { info, settle });
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private safeEmitApprovalResolved(
    ctx: { projectId: string; conversationId: string; laneId?: string },
    approvalId: string,
    decision: 'allow' | 'deny',
  ): void {
    try {
      this.store.appendEvent({
        id: newId(),
        ts: new Date().toISOString(),
        projectId: ctx.projectId,
        conversationId: ctx.conversationId,
        ...(ctx.laneId ? { laneId: ctx.laneId } : {}),
        origin: 'user',
        type: 'approval.resolved',
        payload: { approvalId, decision },
      } as UnsealedEvent);
    } catch {
      // auditing must never break the waiter
    }
  }

  /** The composition root attaches the (opt-in) scheduler — ADR-0036. */
  private scheduler: { status(): SchedulerStatus } | null = null;

  attachScheduler(s: { status(): SchedulerStatus }): void {
    this.scheduler = s;
  }

  /** Two-signal heartbeat + job list; null = no scheduler running (honest). */
  getSchedulerStatus(): SchedulerStatus | null {
    return this.scheduler ? this.scheduler.status() : null;
  }

  /** The composition root (amritad bin) marks a channel runner as live. */
  markChannelRunnerActive(channel: string, active = true): void {
    if (active) this.activeChannelRunners.add(channel);
    else this.activeChannelRunners.delete(channel);
  }

  isChannelRunnerActive(channel: string): boolean {
    return this.activeChannelRunners.has(channel);
  }

  /** Pending approvals, oldest first. Runtime state; the log holds the audit trail. */
  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].map((p) => p.info);
  }

  /** Resolve a pending approval. Unknown/already-settled ids report resolved:false. */
  resolveApproval(
    approvalId: string,
    decision: 'allow' | 'deny',
  ): { approvalId: string; resolved: boolean } {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return { approvalId, resolved: false };
    pending.settle(decision);
    return { approvalId, resolved: true };
  }

  /**
   * Start a lane: emit `lane.spawned` + `lane.mandate`, then (unless `dryRun`)
   * run it through the lane runner, streaming `lane.progress` and finishing with
   * `lane.merge_report` + `lane.completed`/`lane.aborted`. With `detach` the call
   * returns immediately (status `running`) and the lane runs in the background,
   * cancellable via {@link cancelLane}; otherwise it awaits completion.
   *
   * Safety (ADR-0015): the default runner refuses real Claude Code execution, so
   * a non-dry start ends safely as `aborted` unless the daemon opted in. A `real`
   * request on a non-opted-in daemon fails safely WITHOUT running. Secret-free.
   */
  async startLane(input: LaneStartInput): Promise<LaneStartResult> {
    const conv = this.store.getConversation(input.conversationId);
    if (!conv) throw new Error(`no such conversation: ${input.conversationId}`);
    const projectId = conv.projectId;
    const conversationId = input.conversationId;
    const laneId = newId();
    const kind = input.kind ?? 'claude-code';

    // ADR-0039: a real run always gets a workspace. When the caller names no
    // paths, confine the lane to <allowed-root>/<laneId> — the UI never needs
    // to know filesystem paths, and the canvas can serve the output.
    let scope = (input.scope ?? {}) as { paths?: string[] } & Record<string, unknown>;
    if (
      this.realLaneExecution &&
      !input.dryRun &&
      this.laneWorkspacesRoot &&
      (scope.paths ?? []).length === 0
    ) {
      const workspace = join(this.laneWorkspacesRoot, laneId);
      mkdirSync(workspace, { recursive: true });
      scope = { ...scope, paths: [workspace] };
    }

    const mandate = laneMandateSchema.parse({
      laneId,
      goal: input.goal,
      contextPack: input.contextPack ?? {},
      scope,
      budget: input.budget ?? {},
      ...(input.approvals ? { approvals: input.approvals } : {}),
      deliverables: input.deliverables ?? [],
    });

    this.emitLaneEvent(projectId, conversationId, laneId, 'lane.spawned', { laneId, kind });
    this.emitLaneEvent(projectId, conversationId, laneId, 'lane.mandate', mandate);

    if (input.dryRun) {
      return { laneId, status: 'spawned', dryRun: true, detached: false, report: null };
    }

    // ADR-0023: dispatch by kind; an unknown kind aborts honestly instead of
    // silently running the default (Claude Code) runner.
    const runner = this.laneRunnerFor(kind);
    if (!runner) {
      const error = `no runner registered for lane kind: ${kind}`;
      this.emitLaneEvent(projectId, conversationId, laneId, 'lane.aborted', {
        laneId,
        reason: error,
      });
      return { laneId, status: 'aborted', dryRun: false, detached: false, report: null, error };
    }

    // Explicit real intent on a daemon that has not opted in → safe failure, no run.
    if (input.real && !this.realLaneExecution) {
      const error =
        'real lane execution is disabled on this daemon (set AMRITA_LANES_ALLOW_REAL_EXECUTION=1 or pass allowRealLaneExecution)';
      this.emitLaneEvent(projectId, conversationId, laneId, 'lane.aborted', {
        laneId,
        reason: error,
      });
      return { laneId, status: 'aborted', dryRun: false, detached: false, report: null, error };
    }

    // ADR-0021: on a daemon that has opted into real execution, EVERY non-dry
    // run under the default 'forward' policy requires an operator approval —
    // the runner there executes for real whether or not the caller said
    // `real: true`, so keying the gate on the flag alone would be a bypass.
    // 'auto-safe'/'sandboxed' policies skip the gate (pre-authorized posture);
    // non-opted daemons are ungated because their runner refuses real exec.
    // ADR-0048 — the Approval Constitution replaces the one-line gate. 'forward'
    // still gates anything real (behavior UNCHANGED); the fix is that 'auto-safe'/
    // 'sandboxed' no longer BLINDLY skip the gate for MATERIAL actions (writes to the
    // shared root, spend over cap, network, scope overlap, deploy/push, an
    // interactive session). Operational jailed work under those policies proceeds.
    const activeScopes = [...this.activeLanes.keys()]
      .map((id) => this.store.getLane(id))
      .filter((l): l is LaneRow => Boolean(l))
      .map((l) => {
        try {
          const scope = (JSON.parse(l.mandateJson) as { scope?: { paths?: string[] } }).scope;
          return { laneId: l.id, paths: scope?.paths ?? [] };
        } catch {
          return { laneId: l.id, paths: [] as string[] };
        }
      });
    const verdict = resolveApprovalPolicy(mandate, {
      realExecution: this.realLaneExecution,
      dryRun: false,
      kind,
      workspacesRoot: this.laneWorkspacesRoot,
      maxUsdCap: Number(process.env.AMRITA_LANES_APPROVAL_MAX_USD ?? '2') || 2,
      maxTokensCap: Number(process.env.AMRITA_LANES_APPROVAL_MAX_TOKENS ?? '200000') || 200_000,
      scopeConflicts: activeScopeConflicts(mandate.scope.paths ?? [], activeScopes),
    });
    const requireApproval = verdict.gate === 'approval';

    const controller = new AbortController();
    // An interactive tmux session (ADR-0049) is DURABLE (survives the daemon) and has
    // a separate graceful-FINISH signal, distinct from cancel (controller.abort()).
    const durable = kind.endsWith('-tmux');
    const finishController = durable ? new AbortController() : undefined;
    const promise = this.runLaneToCompletion(
      projectId,
      conversationId,
      laneId,
      mandate,
      runner,
      controller.signal,
      requireApproval,
      finishController?.signal,
    ).finally(() => this.activeLanes.delete(laneId));
    this.activeLanes.set(laneId, {
      controller,
      promise,
      ...(durable ? { durable: true } : {}),
      ...(finishController ? { finishController } : {}),
    });

    if (input.detach) {
      return { laneId, status: 'running', dryRun: false, detached: true, report: null };
    }

    const settled = await promise;
    return {
      laneId,
      status: settled.status,
      dryRun: false,
      detached: false,
      report: settled.report,
      ...(settled.error ? { error: settled.error } : {}),
    };
  }

  /** Run the lane to completion, emitting lifecycle events. Never throws. */
  private async runLaneToCompletion(
    projectId: string,
    conversationId: string,
    laneId: string,
    mandate: Parameters<LaneRunner['run']>[0],
    runner: LaneRunner,
    signal: AbortSignal,
    requireApproval = false,
    finishSignal?: AbortSignal,
    sessionGoalAlreadySent?: boolean,
  ): Promise<LaneSettleResult> {
    if (requireApproval) {
      this.safeEmitLane(projectId, conversationId, laneId, 'lane.progress', {
        note: 'awaiting operator approval for real execution',
      });
      const decision = await this.requestApproval(
        { projectId, conversationId, laneId },
        'lane.run-real',
        mandate.goal,
        { signal },
      );
      if (decision !== 'allow') {
        const reason =
          decision === 'timeout'
            ? 'real run approval timed out (denied by default)'
            : 'real run denied by operator';
        this.safeEmitLane(projectId, conversationId, laneId, 'lane.aborted', { laneId, reason });
        return { status: 'aborted', report: null, error: reason };
      }
    }
    try {
      const report = await runner.run(mandate, {
        signal,
        ...(finishSignal ? { finishSignal } : {}),
        ...(sessionGoalAlreadySent !== undefined ? { sessionGoalAlreadySent } : {}),
        onProgress: (note, pct) => {
          if (note === SESSION_GOAL_SENT_PROGRESS) this.sessionGoalSentLanes.add(laneId);
          this.safeEmitLane(
            projectId,
            conversationId,
            laneId,
            'lane.progress',
            clean({ note, pct }),
          );
        },
        // ADR-0049: the live tmux pane, stream-only — for the operator to watch, never
        // persisted (domain truth is the workspace files, not the screen).
        onPane: (text) => this.emitLanePane(projectId, conversationId, laneId, text),
      });
      const sealed = mergeReportSchema.parse({ ...report, laneId });
      this.safeEmitLane(projectId, conversationId, laneId, 'lane.merge_report', sealed);
      // ADR-0045: the lane's TYPED outputs used to be thrown away — `project.ts`
      // projected `merge_json` and nothing else, so a lane could report that it
      // created three tasks and zero rows would appear. They are proposals now,
      // and they land in the same Inbox as everything else an agent produces.
      this.captureMergeReport(projectId, conversationId, sealed);
      // `cancelled` and `aborted` are terminal-aborted in the row state machine;
      // the precise disposition lives in the merge report's `exit`.
      if (sealed.exit === 'aborted' || sealed.exit === 'cancelled') {
        this.safeEmitLane(projectId, conversationId, laneId, 'lane.aborted', {
          laneId,
          reason: sealed.summary || sealed.exit,
        });
        return { status: 'aborted', report: sealed };
      }
      this.safeEmitLane(projectId, conversationId, laneId, 'lane.completed', {
        laneId,
        exit: sealed.exit,
      });
      return { status: 'completed', report: sealed };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.safeEmitLane(projectId, conversationId, laneId, 'lane.aborted', { laneId, reason });
      return { status: 'aborted', report: null, error: reason };
    }
  }

  /** Cancel a running lane (aborts the runner); resolves once it has stopped. */
  async cancelLane(laneId: string): Promise<LaneCancelResult> {
    const entry = this.activeLanes.get(laneId);
    if (!entry) {
      return { laneId, cancelled: false, status: this.store.getLane(laneId)?.status ?? null };
    }
    entry.controller.abort();
    await entry.promise;
    return { laneId, cancelled: true, status: this.store.getLane(laneId)?.status ?? null };
  }

  /** Await a (possibly detached) lane's completion. Resolves immediately if not active. */
  async awaitLane(laneId: string): Promise<void> {
    const entry = this.activeLanes.get(laneId);
    if (entry) await entry.promise;
  }

  /**
   * Gracefully finish an interactive tmux session (ADR-0049): the runner captures a
   * final pane, tears the session down, and reports `done`/`partial` — distinct from
   * `cancelLane`, which aborts to `cancelled`. No-op on a non-session lane.
   */
  finishSession(projectId: string, laneId: string): { laneId: string; finished: boolean } {
    const lane = this.store.getLane(laneId);
    if (!lane || lane.projectId !== projectId || !lane.kind.endsWith('-tmux')) {
      return { laneId, finished: false };
    }
    const entry = this.activeLanes.get(laneId);
    if (!entry?.finishController) return { laneId, finished: false };
    entry.finishController.abort();
    return { laneId, finished: true };
  }

  /** Project-scoped cancellation for Session Workspace; never reveals another project. */
  async cancelSession(projectId: string, laneId: string): Promise<LaneCancelResult> {
    const lane = this.store.getLane(laneId);
    if (!lane || lane.projectId !== projectId || !lane.kind.endsWith('-tmux')) {
      return { laneId, cancelled: false, status: null };
    }
    return this.cancelLane(laneId);
  }

  /**
   * Type literal input into an interactive session's pane (ADR-0050) — the operator
   * (or Amrita) answering or redirecting mid-session. The session name is derivable
   * (`amrita-<laneId>`); tmux `send-keys -l` never interprets text as a shell command.
   *
   * Safety boundary: capture and classify immediately before every write. Login and
   * boot/trust screens reject text instead of accepting credentials or a goal by
   * accident. The durable lane row + live tmux session are sufficient during a
   * restart re-attachment window; an in-memory runner entry is not treated as SSOT.
   */
  async sendSessionInput(
    projectId: string,
    laneId: string,
    text: string,
  ): Promise<{ laneId: string; sent: boolean }> {
    const lane = this.store.getLane(laneId);
    if (
      !lane ||
      lane.projectId !== projectId ||
      !lane.kind.endsWith('-tmux') ||
      lane.status === 'completed' ||
      lane.status === 'aborted'
    ) {
      return { laneId, sent: false };
    }
    const name = `amrita-${laneId}`;
    const state = await this.tmux.sessionState(name);
    const expectedAgent = lane.kind === 'codex-tmux' ? 'codex' : 'claude';
    let expectedCwd: string | null = null;
    try {
      const mandate = laneMandateSchema.parse(JSON.parse(lane.mandateJson));
      expectedCwd = mandate.scope.paths?.[0] ?? null;
    } catch {
      return { laneId, sent: false };
    }
    if (
      !state.exists ||
      state.dead ||
      state.agent !== expectedAgent ||
      state.cwd === null ||
      expectedCwd === null ||
      resolve(state.cwd) !== resolve(expectedCwd)
    ) {
      return { laneId, sent: false };
    }
    let pane: string;
    try {
      // Visible screen only — scrollback would re-detect an already-answered
      // trust dialog and wrongly refuse legitimate input (found live, 2026-07-16).
      pane = await this.tmux.capturePane(name, 0);
    } catch {
      throw new Error(`conflict: session ${laneId} became unavailable before input`);
    }
    const boot = classifyBootPane(pane);
    if (boot === 'login') {
      throw new Error(`conflict: session ${laneId} is awaiting authentication`);
    }
    if (boot === 'prompt') {
      throw new Error(`conflict: session ${laneId} is still at a trusted startup prompt`);
    }
    if (boot === 'blocked') {
      throw new Error(`conflict: session ${laneId} needs an operator choice in the CLI`);
    }
    const auditedGoal = this.sessionGoalWasSent(lane.conversationId, laneId);
    if (!state.goalSent && !auditedGoal) {
      throw new Error(`conflict: session ${laneId} has not received its initial goal yet`);
    }
    if (state.goalSent && !auditedGoal) {
      this.sessionGoalSentLanes.add(laneId);
      this.safeEmitLane(lane.projectId, lane.conversationId, laneId, 'lane.progress', {
        note: SESSION_GOAL_SENT_PROGRESS,
        pct: 15,
      });
    }
    await this.tmux.sendKeys(name, text, { enter: true });
    return { laneId, sent: true };
  }

  // ── channel pairings (delegated; ADR-0013) ────────────────────────────────

  createPairing(input: {
    channel: string;
    projectId: string;
    conversationId?: string;
  }): PairingRow {
    return this.store.createPairing(input);
  }

  consumePairing(input: { channel: string; code: string; externalUserId: string }): ChannelLink {
    return this.store.consumePairing(input);
  }

  getChannelLink(channel: string, externalUserId: string): ChannelLink | undefined {
    return this.store.getChannelLink(channel, externalUserId);
  }

  /**
   * Deterministic channel-session resolution (R2 / Hermes session-key lesson):
   * every channel identity maps into the SAME store-backed conversation — one
   * brain, no per-channel memory. A pairing without a conversation gets the
   * project's `(default)` conversation, created once.
   */
  resolveChannelSession(
    channel: string,
    externalUserId: string,
  ): { projectId: string; conversationId: string } | undefined {
    const link = this.store.getChannelLink(channel, externalUserId);
    if (!link) return undefined;
    if (link.conversationId) {
      return { projectId: link.projectId, conversationId: link.conversationId };
    }
    const existing = this.store
      .listConversations(link.projectId)
      .find((c) => c.title === '(default)');
    const conversationId =
      existing?.id ??
      this.store.createConversation({ projectId: link.projectId, title: '(default)' }).id;
    return { projectId: link.projectId, conversationId };
  }

  listPairings(channel?: string): PairingRow[] {
    return this.store.listPairings(channel);
  }
}
