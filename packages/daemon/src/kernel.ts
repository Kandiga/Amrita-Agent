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
  type ConnectorRow,
  type ConversationNode,
  type DecisionRow,
  type EntityWriteOpts,
  type LaneRow,
  type LaneStatus,
  type MemoryEntryRow,
  type MemoryScope,
  type ProviderConfigStatus,
  type Store,
  type TaskRow,
  type TaskStatus,
  openStore,
} from '@amrita/store';
import { type ChatUsage, ProviderError, type ProviderInfo, ProviderRegistry } from './provider.ts';
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
  private readonly providers = new ProviderRegistry();

  private constructor(store: Store, dbPath: string, startedAt: string) {
    this.store = store;
    this.dbPath = dbPath;
    this.startedAt = startedAt;
  }

  /** Open (creating + migrating) the store and start the kernel. */
  static open(opts: KernelOptions): AmritaKernel {
    const store = openStore({
      path: opts.dbPath,
      ...(opts.spillDir ? { spillDir: opts.spillDir } : {}),
    });
    return new AmritaKernel(store, opts.dbPath, new Date().toISOString());
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

  listProviders(): ProviderInfo[] {
    return this.providers.list();
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
   * Run one non-streaming chat turn: record the user message, invoke the provider
   * boundary (a side effect, OUTSIDE any store transaction), then persist the
   * assistant message + turn/model events. Defaults to the deterministic `mock`
   * provider. Requesting a real provider/account returns a safe structured error.
   * The result contains no secret values.
   */
  runChatTurn(input: ChatTurnInput): ChatTurnResult {
    const conv = this.store.getConversation(input.conversationId);
    if (!conv)
      throw new ProviderError('not_found', `no such conversation: ${input.conversationId}`);
    const projectId = conv.projectId;

    // Requesting a real account is not runnable yet — fail safely (no secret read).
    if (input.accountId) {
      const status = this.store.getProviderConfigStatus(input.accountId);
      if (!status) throw new ProviderError('not_found', `no such account: ${input.accountId}`);
      throw new ProviderError(
        'provider_unavailable',
        `real provider execution is not implemented yet (account status: ${status})`,
      );
    }

    const providerId = input.provider ?? 'mock';
    const provider = this.providers.resolveChat(providerId); // throws ProviderError if unavailable
    const model = input.model ?? (providerId === 'mock' ? 'mock-default' : 'default');
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
    const resp = provider.generate({ messages, model });

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
}
