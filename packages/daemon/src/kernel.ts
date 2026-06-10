import type { AmritaEvent, ConversationRow, ProjectRow } from '@amrita/protocol';
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
import { clean } from './util.ts';

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
