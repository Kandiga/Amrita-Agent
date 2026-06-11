import { ClaudeCodeLaneRunner, type LaneRunner, ResearchLaneRunner } from '@amrita/lanes';
import {
  type AmritaEvent,
  type ConnectorStatusReport,
  type ConversationRow,
  type MergeReport,
  type ProjectRow,
  type UnsealedEvent,
  laneMandateSchema,
  mergeReportSchema,
  newId,
  parseEvent,
} from '@amrita/protocol';
import {
  type AccountRow,
  type AuthMode,
  type ChannelLink,
  type ConnectorRow,
  type ConversationNode,
  type DecisionRow,
  type EntityWriteOpts,
  type LaneRow,
  type LaneStatus,
  type MemoryEntryRow,
  type MemoryScope,
  type MilestoneRow,
  type MilestoneStatus,
  type OpenQuestionRow,
  type PairingRow,
  type PreviewApprovalRow,
  type ProjectBrandRow,
  type ProjectBriefRow,
  type ProviderConfigStatus,
  type QuestionStatus,
  type RiskRow,
  type RiskSeverity,
  type Store,
  type TaskRow,
  type TaskStatus,
  openStore,
} from '@amrita/store';
import { connectorStatuses } from './connectors.ts';
import { fetchGithubIssues } from './github.ts';
import {
  type ChatProvider,
  type ChatUsage,
  type FetchLike,
  MOCK_PROVIDER_ID,
  MockProvider,
  ProviderError,
  type ProviderInfo,
  type ProviderRole,
  REAL_PROVIDERS,
  type RoleBinding,
  defaultFetch,
  envPresent,
  parseRoleBinding,
  readEnvSecret,
  roleSettingKey,
} from './provider.ts';
import { type CodingRuntimeStatus, type CommandProber, getClaudeCodeStatus } from './runtimes.ts';
import { clean } from './util.ts';

/** A chat turn request. */
export interface ChatTurnInput {
  conversationId: string;
  text: string;
  provider?: string;
  model?: string;
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
  /** Opt-in to REAL Claude Code lane execution. Default false (also `AMRITA_LANES_ALLOW_REAL_EXECUTION=1`). */
  allowRealLaneExecution?: boolean;
  /** Workspace roots a real lane's cwd must resolve within (also `AMRITA_LANES_ALLOWED_ROOTS`, `:`-sep). */
  laneAllowedRoots?: string[];
  /** Injectable coding-runtime prober (tests pass a fake; defaults to bounded spawn). */
  codingRuntimeProber?: CommandProber;
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
  /** Additional runners dispatched by lane kind (ADR-0023), e.g. `research`. */
  private readonly extraLaneRunners: Map<string, LaneRunner>;
  private readonly codingRuntimeProber: CommandProber | undefined;
  private readonly activeLanes = new Map<
    string,
    { controller: AbortController; promise: Promise<LaneSettleResult> }
  >();
  /** Listeners for STREAM-ONLY events (model.delta) — never persisted (D8). */
  private readonly streamListeners = new Set<(ev: AmritaEvent) => void>();
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
    codingRuntimeProber: CommandProber | undefined,
    approvalTimeoutMs: number,
  ) {
    this.store = store;
    this.dbPath = dbPath;
    this.startedAt = startedAt;
    this.fetchImpl = fetchImpl;
    this.defaultLaneRunner = defaultLaneRunner;
    this.extraLaneRunners = extraLaneRunners;
    this.realLaneExecution = realLaneExecution;
    this.codingRuntimeProber = codingRuntimeProber;
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
    const laneRunner =
      opts.laneRunner ??
      (realLaneExecution
        ? new ClaudeCodeLaneRunner({ allowRealExecution: true, allowedRoots })
        : new ClaudeCodeLaneRunner());
    // Kind-dispatched runners (ADR-0023): research ships unwired (honest
    // needs-setup abort); injected extras override by kind (tests wire a provider).
    const extraLaneRunners = new Map<string, LaneRunner>();
    for (const r of [new ResearchLaneRunner(), ...(opts.extraLaneRunners ?? [])]) {
      extraLaneRunners.set(r.kind, r);
    }
    return new AmritaKernel(
      store,
      opts.dbPath,
      new Date().toISOString(),
      opts.fetchImpl ?? defaultFetch,
      laneRunner,
      extraLaneRunners,
      realLaneExecution,
      opts.codingRuntimeProber,
      opts.approvalTimeoutMs ?? 120_000,
    );
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
    // Abort any in-flight (detached) lanes so no child outlives the daemon.
    for (const { controller } of this.activeLanes.values()) controller.abort();
    this.activeLanes.clear();
    for (const pending of this.pendingApprovals.values()) pending.settle('deny');
    this.pendingApprovals.clear();
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

  // ── chat turn + providers ────────────────────────────────────────────────

  /** Provider availability from account config + env presence. No secret values. */
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
        const bound = accounts.filter((a) => a.provider === spec.id && a.secretRef);
        const envReady = bound.some((a) => a.secretRef !== null && envPresent(a.secretRef));
        return {
          id: spec.id,
          kind: 'real',
          available: envReady,
          configuredAccounts: bound.length,
          envReady,
          streaming: spec.streaming,
        };
      }),
    ];
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
    return [
      await getClaudeCodeStatus({
        realExecution: this.realLaneExecution,
        ...(this.codingRuntimeProber ? { prober: this.codingRuntimeProber } : {}),
      }),
    ];
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
    if (!this.listProviders().some((p) => p.id === input.provider)) {
      throw new ProviderError('unknown_provider', `unknown provider: ${input.provider}`);
    }
    if (input.projectId && !this.store.getProject(input.projectId)) {
      throw new ProviderError('not_found', `no such project: ${input.projectId}`);
    }
    this.store.updateSetting({
      ...this.systemWriteContext(),
      key: roleSettingKey(input.role, input.projectId),
      value: { provider: input.provider, ...(input.model ? { model: input.model } : {}) },
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
  ): { provider: string; model?: string; via: 'project' | 'binding' | 'auto' } {
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
    const providerId = requested ?? MOCK_PROVIDER_ID;
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

    // Default account rule: first bound account for this provider.
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
    return {
      providerId,
      model,
      provider: spec.create({ apiKey, model, fetchImpl: this.fetchImpl }),
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
    const messages = this.store
      .listMessages(input.conversationId)
      .map((m) => ({ role: m.role, text: m.text }));
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
    } & EntityWriteOpts,
  ): { taskId: string } {
    return { taskId: this.store.createTask(input).taskId };
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
      sourceMessageId?: string;
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

  getLane(laneId: string): LaneRow | undefined {
    return this.store.getLane(laneId);
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

    const mandate = laneMandateSchema.parse({
      laneId,
      goal: input.goal,
      contextPack: input.contextPack ?? {},
      scope: input.scope ?? {},
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
    const requireApproval = this.realLaneExecution && mandate.approvals === 'forward';

    const controller = new AbortController();
    const promise = this.runLaneToCompletion(
      projectId,
      conversationId,
      laneId,
      mandate,
      runner,
      controller.signal,
      requireApproval,
    ).finally(() => this.activeLanes.delete(laneId));
    this.activeLanes.set(laneId, { controller, promise });

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
        onProgress: (note, pct) =>
          this.safeEmitLane(
            projectId,
            conversationId,
            laneId,
            'lane.progress',
            clean({ note, pct }),
          ),
      });
      const sealed = mergeReportSchema.parse({ ...report, laneId });
      this.safeEmitLane(projectId, conversationId, laneId, 'lane.merge_report', sealed);
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

  listPairings(channel?: string): PairingRow[] {
    return this.store.listPairings(channel);
  }
}
