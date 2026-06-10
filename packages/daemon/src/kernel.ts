import {
  type AmritaEvent,
  type ConversationRow,
  type ProjectRow,
  type UnsealedEvent,
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
}

export interface KernelOptions {
  /** SQLite path, or ':memory:'. */
  dbPath: string;
  spillDir?: string;
  /** Injectable fetch for real provider adapters (tests pass a fake; defaults to global fetch). */
  fetchImpl?: FetchLike;
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
  private readonly mock = new MockProvider();
  private readonly fetchImpl: FetchLike;

  private constructor(store: Store, dbPath: string, startedAt: string, fetchImpl: FetchLike) {
    this.store = store;
    this.dbPath = dbPath;
    this.startedAt = startedAt;
    this.fetchImpl = fetchImpl;
  }

  /** Open (creating + migrating) the store and start the kernel. */
  static open(opts: KernelOptions): AmritaKernel {
    const store = openStore({
      path: opts.dbPath,
      ...(opts.spillDir ? { spillDir: opts.spillDir } : {}),
    });
    return new AmritaKernel(
      store,
      opts.dbPath,
      new Date().toISOString(),
      opts.fetchImpl ?? defaultFetch,
    );
  }

  close(): void {
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
