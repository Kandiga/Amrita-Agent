import { ClaudeCodeLaneRunner, type LaneRunner } from '@amrita/lanes';
import {
  type AmritaEvent,
  type ConversationRow,
  type MergeReport,
  type ProjectRow,
  type UnsealedEvent,
  laneMandateSchema,
  mergeReportSchema,
  newId,
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
  type PairingRow,
  type ProviderConfigStatus,
  type Store,
  type TaskRow,
  type TaskStatus,
  openStore,
} from '@amrita/store';
import {
  type ChatProvider,
  type ChatUsage,
  type FetchLike,
  MOCK_PROVIDER_ID,
  MockProvider,
  ProviderError,
  type ProviderInfo,
  REAL_PROVIDERS,
  defaultFetch,
  envPresent,
  readEnvSecret,
} from './provider.ts';
import { clean } from './util.ts';

/** A non-streaming chat turn request. */
export interface ChatTurnInput {
  conversationId: string;
  text: string;
  provider?: string;
  model?: string;
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
  /** Opt-in to REAL Claude Code lane execution. Default false (also `AMRITA_LANES_ALLOW_REAL_EXECUTION=1`). */
  allowRealLaneExecution?: boolean;
  /** Workspace roots a real lane's cwd must resolve within (also `AMRITA_LANES_ALLOWED_ROOTS`, `:`-sep). */
  laneAllowedRoots?: string[];
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
  private readonly laneRunner: LaneRunner;
  private readonly activeLanes = new Map<
    string,
    { controller: AbortController; promise: Promise<LaneSettleResult> }
  >();
  private closed = false;

  private constructor(
    store: Store,
    dbPath: string,
    startedAt: string,
    fetchImpl: FetchLike,
    laneRunner: LaneRunner,
    realLaneExecution: boolean,
  ) {
    this.store = store;
    this.dbPath = dbPath;
    this.startedAt = startedAt;
    this.fetchImpl = fetchImpl;
    this.laneRunner = laneRunner;
    this.realLaneExecution = realLaneExecution;
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
    return new AmritaKernel(
      store,
      opts.dbPath,
      new Date().toISOString(),
      opts.fetchImpl ?? defaultFetch,
      laneRunner,
      realLaneExecution,
    );
  }

  close(): void {
    this.closed = true;
    // Abort any in-flight (detached) lanes so no child outlives the daemon.
    for (const { controller } of this.activeLanes.values()) controller.abort();
    this.activeLanes.clear();
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
        };
      }),
    ];
  }

  /**
   * Resolve the concrete provider for a turn. For real providers this reads the
   * account's bound `secret_ref` env var **here only** and hands the value to the
   * adapter; the value never leaves this method. Throws a structured, secret-free
   * `ProviderError` for any config/availability problem.
   */
  private resolveChatProvider(input: ChatTurnInput): {
    providerId: string;
    model: string;
    provider: ChatProvider;
  } {
    let account = input.accountId
      ? this.store.listAccounts().find((a) => a.id === input.accountId)
      : undefined;
    if (input.accountId && !account) {
      throw new ProviderError('not_found', `no such account: ${input.accountId}`);
    }
    const providerId = input.provider ?? account?.provider ?? MOCK_PROVIDER_ID;
    if (account && input.provider && input.provider !== account.provider) {
      throw new ProviderError(
        'unknown_provider',
        `account provider '${account.provider}' does not match requested '${input.provider}'`,
      );
    }

    if (providerId === MOCK_PROVIDER_ID) {
      return { providerId, model: input.model ?? 'mock-default', provider: this.mock };
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
    const model = input.model ?? spec.defaultModel;
    return {
      providerId,
      model,
      provider: spec.create({ apiKey, model, fetchImpl: this.fetchImpl }),
    };
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

    // Resolve the provider first — a config error records nothing.
    const { providerId, model, provider } = this.resolveChatProvider(input);
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
      role: 'main',
    });

    // Provider call — pure side effect, outside any store transaction.
    const messages = this.store
      .listMessages(input.conversationId)
      .map((m) => ({ role: m.role, text: m.text }));
    let resp: Awaited<ReturnType<ChatProvider['generate']>>;
    try {
      resp = await provider.generate({ messages, model });
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

    const controller = new AbortController();
    const promise = this.runLaneToCompletion(
      projectId,
      conversationId,
      laneId,
      mandate,
      controller.signal,
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
    signal: AbortSignal,
  ): Promise<LaneSettleResult> {
    try {
      const report = await this.laneRunner.run(mandate, {
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
