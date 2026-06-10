import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AmritaEvent,
  type ConversationRow,
  type EventChannel,
  type EventOrigin,
  type EventType,
  type MessageRow,
  type ProjectRow,
  type UnsealedEvent,
  isSafeEnvSecretRefName,
  isStreamOnly,
  newId,
  parseEvent,
  parseUnsealedEvent,
} from '@amrita/protocol';
import Database from 'better-sqlite3';
import { migrateUp } from './migrate.ts';
import { applyEventProjection } from './project.ts';

type DB = Database.Database;

/** Tool-completed payloads larger than this are spilled to an artifact file. */
export const SPILL_THRESHOLD_BYTES = 32 * 1024;

export interface OpenStoreOptions {
  /** Path to the SQLite database file, or ':memory:'. */
  path: string;
  /** Directory for spilled tool payloads. Defaults to `<db dir>/artifacts`. */
  spillDir?: string;
}

export interface SearchHit {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  snippet: string;
  /** bm25 score — lower is a better match (results are ordered best-first). */
  rank: number;
}

export interface RecordUserMessageInput {
  projectId: string;
  conversationId: string;
  text: string;
  turnId?: string;
  channel?: EventChannel;
}

/** Envelope context shared by every entity-write API (ADR-0007). */
export interface EntityWriteOpts {
  /** Who caused this (defaults to `system`). */
  origin?: EventOrigin;
  turnId?: string;
  laneId?: string;
  channel?: EventChannel;
}

export type TaskStatus = 'now' | 'later' | 'done' | 'dropped';
export type MemoryScope = 'user' | 'project';
export type ConnectorStatus = 'needs_setup' | 'ready' | 'error' | 'disabled';
export type AuthMode = 'api_key' | 'subscription_cli' | 'local_endpoint' | 'oauth';
export type LaneStatus = 'spawned' | 'running' | 'merging' | 'completed' | 'aborted';
export type ProviderConfigStatus =
  | 'missing_secret_ref'
  | 'secret_ref_bound'
  | 'degraded'
  | 'healthy';

export interface TaskRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  laneId: string | null;
  status: TaskStatus;
  title: string;
  body: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  supersedesId: string | null;
  text: string;
  createdAt: string;
}

export interface MemoryEntryRow {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  charCount: number;
  source: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorRow {
  id: string;
  slug: string;
  kind: string;
  status: ConnectorStatus;
  manifestJson: string | null;
  configJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Account row — `secretRef` is an env-NAME, never a secret value (ADR-0003). */
export interface AccountRow {
  id: string;
  provider: string;
  label: string | null;
  authMode: AuthMode;
  secretRef: string | null;
  metadataJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountHealth {
  health: string | null;
  healthReason: string | null;
  healthAt: string | null;
}

export interface LaneRow {
  id: string;
  projectId: string;
  conversationId: string;
  kind: string;
  status: LaneStatus;
  mandateJson: string;
  budgetJson: string | null;
  mergeJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationNode {
  id: string;
  projectId: string;
  title: string | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

function now(): string {
  return new Date().toISOString();
}

/** Drop null columns so the strict envelope schema (string | undefined) accepts the row. */
function rowToEvent(row: Record<string, unknown>): AmritaEvent {
  const env: Record<string, unknown> = {
    id: row.id,
    seq: row.seq,
    ts: row.ts,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    origin: row.origin,
    type: row.type,
    payload: JSON.parse(row.payload_json as string),
  };
  if (row.turn_id != null) env.turnId = row.turn_id;
  if (row.lane_id != null) env.laneId = row.lane_id;
  if (row.channel != null) env.channel = row.channel;
  return parseEvent(env);
}

export class Store {
  readonly db: DB;
  private readonly spillDir: string;

  constructor(opts: OpenStoreOptions) {
    this.db = new Database(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.spillDir =
      opts.spillDir ?? join(opts.path === ':memory:' ? '.' : dirname(opts.path), 'artifacts');
    migrateUp(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ── projects & conversations ────────────────────────────────────────────

  createProject(input: { slug: string; name: string; root?: string }): ProjectRow {
    const ts = now();
    const row: ProjectRow = {
      id: newId(),
      slug: input.slug,
      name: input.name,
      root: input.root ?? null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO projects (id, slug, name, root, created_at, updated_at)
         VALUES (@id, @slug, @name, @root, @createdAt, @updatedAt)`,
      )
      .run(row);
    return row;
  }

  createConversation(input: {
    projectId: string;
    title?: string;
    parentId?: string;
  }): ConversationRow {
    const ts = now();
    const row: ConversationRow = {
      id: newId(),
      projectId: input.projectId,
      title: input.title ?? null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
    };
    // parent_id integrity (exists / not self) is enforced by SQL triggers (ADR-0003).
    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived_at, parent_id)
         VALUES (@id, @projectId, @title, @createdAt, @updatedAt, @archivedAt, @parentId)`,
      )
      .run({ ...row, parentId: input.parentId ?? null });
    return row;
  }

  // ── events ──────────────────────────────────────────────────────────────

  private nextSeq(conversationId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE conversation_id = ?')
      .get(conversationId) as { next: number };
    return row.next;
  }

  private insertEventRow(ev: AmritaEvent): void {
    this.db
      .prepare(
        `INSERT INTO events
           (id, seq, ts, project_id, conversation_id, turn_id, lane_id, origin, channel, type, payload_json)
         VALUES (@id, @seq, @ts, @projectId, @conversationId, @turnId, @laneId, @origin, @channel, @type, @payloadJson)`,
      )
      .run({
        id: ev.id,
        seq: ev.seq,
        ts: ev.ts,
        projectId: ev.projectId,
        conversationId: ev.conversationId,
        turnId: ev.turnId ?? null,
        laneId: ev.laneId ?? null,
        origin: ev.origin,
        channel: ev.channel ?? null,
        type: ev.type,
        payloadJson: JSON.stringify(ev.payload),
      });
  }

  /**
   * Plan a spill for a large `tool.completed` result: insert the `artifacts` row
   * and rewrite the payload *now* (inside the transaction), but defer the file
   * write to after commit by returning it as `pending` — so a rolled-back spill
   * leaves no orphan file (ADR-0007).
   */
  private prepareSpill(ev: UnsealedEvent): {
    payload: UnsealedEvent['payload'];
    pending: { filePath: string; data: string } | null;
  } {
    if (ev.type !== 'tool.completed') return { payload: ev.payload, pending: null };
    const payload = ev.payload as {
      toolCallId: string;
      result: { result?: unknown; isError?: boolean };
    };
    const serialized = JSON.stringify(payload.result.result ?? null);
    if (Buffer.byteLength(serialized, 'utf8') <= SPILL_THRESHOLD_BYTES) {
      return { payload: ev.payload, pending: null };
    }

    const artifactId = newId();
    const filePath = join(this.spillDir, `${artifactId}.json`);
    this.db
      .prepare(
        `INSERT INTO artifacts (id, conversation_id, kind, path, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifactId,
        ev.conversationId,
        'tool-result',
        filePath,
        Buffer.byteLength(serialized),
        now(),
      );

    return {
      payload: {
        toolCallId: payload.toolCallId,
        result: {
          spilledArtifactId: artifactId,
          preview: serialized.slice(0, 500),
          isError: payload.result.isError ?? false,
        },
      },
      pending: { filePath, data: serialized },
    };
  }

  /**
   * The central write path. Validate an unsealed event, assign a per-conversation
   * monotonic `seq`, spill an oversized tool result if needed, insert the event
   * row, then run the read-model projection (`applyEventProjection`) — all in ONE
   * transaction. If projection fails (FK / CHECK / append-only trigger), the event
   * insert rolls back too. Stream-only events (model.delta) are rejected before the
   * transaction: they live only on the wire.
   */
  appendEvent(input: UnsealedEvent): AmritaEvent {
    const unsealed = parseUnsealedEvent(input);
    if (isStreamOnly(unsealed.type)) {
      throw new Error(`refusing to persist stream-only event: ${unsealed.type}`);
    }
    const tx = this.db.transaction(
      (): { sealed: AmritaEvent; pending: { filePath: string; data: string } | null } => {
        const seq = this.nextSeq(unsealed.conversationId);
        const spill = this.prepareSpill(unsealed);
        const sealed = parseEvent({ ...unsealed, seq, payload: spill.payload });
        this.insertEventRow(sealed);
        applyEventProjection(this.db, sealed); // same-transaction read-model projection
        this.touchConversation(unsealed.conversationId);
        return { sealed, pending: spill.pending };
      },
    );
    const { sealed, pending } = tx();
    if (pending) {
      // Side effect after commit: a rolled-back spill never reaches here (ADR-0007).
      mkdirSync(dirname(pending.filePath), { recursive: true });
      writeFileSync(pending.filePath, pending.data);
    }
    return sealed;
  }

  /**
   * The hybrid model, now expressed through the generalized path: a user message
   * is a `message.user` event whose projection materializes the `messages` row
   * (id == event id) in the same transaction — so a reader can never observe one
   * without the other. This is a thin convenience over `appendEvent`.
   */
  recordUserMessage(input: RecordUserMessageInput): { message: MessageRow; event: AmritaEvent } {
    const event = this.appendEvent({
      id: newId(),
      ts: now(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      origin: 'user',
      type: 'message.user',
      payload: { text: input.text },
    });
    // The message row inserted by the projection is deterministic from the event.
    const message: MessageRow = {
      id: event.id,
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      role: 'user',
      text: input.text,
      createdAt: event.ts,
    };
    return { message, event };
  }

  private touchConversation(conversationId: string): void {
    this.db
      .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
      .run(now(), conversationId);
  }

  /** All events for a conversation with `seq > sinceSeq`, in order. */
  getEvents(conversationId: string, sinceSeq = 0): AmritaEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC')
      .all(conversationId, sinceSeq) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  // ── search ────────────────────────────────────────────────────────────────

  /** Full-text search over message text, ranked best-first by bm25. */
  searchMessages(
    query: string,
    opts: { limit?: number; conversationId?: string } = {},
  ): SearchHit[] {
    const limit = opts.limit ?? 20;
    const where = opts.conversationId ? 'AND m.conversation_id = ?' : '';
    const sql = `
      SELECT m.id AS id,
             m.conversation_id AS conversationId,
             m.role AS role,
             json_extract(m.content_json, '$.text') AS text,
             snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE messages_fts MATCH ? ${where}
      ORDER BY rank
      LIMIT ?`;
    const params = opts.conversationId ? [query, opts.conversationId, limit] : [query, limit];
    return this.db.prepare(sql).all(...params) as SearchHit[];
  }

  // ── public write API (events → projection; never raw table writes) ───────

  /** Build a validated entity event and append it through the atomic path. */
  private emit(
    type: string,
    projectId: string,
    conversationId: string,
    payload: unknown,
    opts: EntityWriteOpts = {},
  ): AmritaEvent {
    return this.appendEvent({
      id: newId(),
      ts: now(),
      projectId,
      conversationId,
      origin: opts.origin ?? 'system',
      ...(opts.turnId ? { turnId: opts.turnId } : {}),
      ...(opts.laneId ? { laneId: opts.laneId } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      type,
      payload,
    } as UnsealedEvent);
  }

  createTask(
    input: {
      projectId: string;
      conversationId: string;
      title: string;
      status?: TaskStatus;
      sourceMessageId?: string;
      laneId?: string;
    } & EntityWriteOpts,
  ): { taskId: string; event: AmritaEvent } {
    const taskId = newId();
    const event = this.emit(
      'task.created',
      input.projectId,
      input.conversationId,
      {
        taskId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(input.laneId ? { laneId: input.laneId } : {}),
        title: input.title,
        ...(input.status ? { status: input.status } : {}),
      },
      input,
    );
    return { taskId, event };
  }

  updateTask(
    input: {
      projectId: string;
      conversationId: string;
      taskId: string;
      status?: TaskStatus;
      title?: string;
      body?: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'task.updated',
      input.projectId,
      input.conversationId,
      {
        taskId: input.taskId,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      },
      input,
    );
    return { event };
  }

  completeTask(
    input: { projectId: string; conversationId: string; taskId: string } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'task.completed',
        input.projectId,
        input.conversationId,
        { taskId: input.taskId },
        input,
      ),
    };
  }

  recordDecision(
    input: {
      projectId: string;
      conversationId: string;
      text: string;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { decisionId: string; event: AmritaEvent } {
    const decisionId = newId();
    const event = this.emit(
      'decision.recorded',
      input.projectId,
      input.conversationId,
      {
        decisionId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        text: input.text,
      },
      input,
    );
    return { decisionId, event };
  }

  supersedeDecision(
    input: {
      projectId: string;
      conversationId: string;
      supersedesId: string;
      text: string;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { decisionId: string; event: AmritaEvent } {
    const decisionId = newId();
    const event = this.emit(
      'decision.superseded',
      input.projectId,
      input.conversationId,
      {
        decisionId,
        supersedesId: input.supersedesId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        text: input.text,
      },
      input,
    );
    return { decisionId, event };
  }

  /**
   * Create or update a memory entry. The envelope `projectId` is the *context*;
   * the payload carries `projectId` only for `scope='project'` (so the table's
   * scope/project CHECK holds). Content is bounded (≤4000) and stored as-is —
   * memory is user data, not a secret surface (ADR-0007).
   */
  putMemoryEntry(
    input: {
      projectId: string;
      conversationId: string;
      scope: MemoryScope;
      content: string;
      entryId?: string;
      source?: string;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { entryId: string; event: AmritaEvent } {
    const entryId = input.entryId ?? newId();
    const event = this.emit(
      'memory.updated',
      input.projectId,
      input.conversationId,
      {
        entryId,
        scope: input.scope,
        content: input.content,
        ...(input.scope === 'project' ? { projectId: input.projectId } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      },
      input,
    );
    return { entryId, event };
  }

  consolidateMemoryEntries(
    input: {
      projectId: string;
      conversationId: string;
      scope: MemoryScope;
      content: string;
      sourceEntryIds: string[];
      resultEntryId?: string;
    } & EntityWriteOpts,
  ): { resultEntryId: string; event: AmritaEvent } {
    const resultEntryId = input.resultEntryId ?? newId();
    const event = this.emit(
      'memory.consolidated',
      input.projectId,
      input.conversationId,
      {
        resultEntryId,
        sourceEntryIds: input.sourceEntryIds,
        content: input.content,
        scope: input.scope,
        ...(input.scope === 'project' ? { projectId: input.projectId } : {}),
      },
      input,
    );
    return { resultEntryId, event };
  }

  /** Set a non-secret config value. Secret-ish keys are rejected by the event schema. */
  updateSetting(
    input: {
      projectId: string;
      conversationId: string;
      key: string;
      value: unknown;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'settings.updated',
        input.projectId,
        input.conversationId,
        { key: input.key, value: input.value },
        input,
      ),
    };
  }

  installConnector(
    input: {
      projectId: string;
      conversationId: string;
      slug: string;
      kind: string;
      connectorId?: string;
    } & EntityWriteOpts,
  ): { connectorId: string; event: AmritaEvent } {
    const connectorId = input.connectorId ?? newId();
    const event = this.emit(
      'connector.installed',
      input.projectId,
      input.conversationId,
      { connectorId, slug: input.slug, kind: input.kind },
      input,
    );
    return { connectorId, event };
  }

  updateConnector(
    input: {
      projectId: string;
      conversationId: string;
      connectorId: string;
      slug: string;
      status?: ConnectorStatus;
      fields?: string[];
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'connector.updated',
      input.projectId,
      input.conversationId,
      {
        connectorId: input.connectorId,
        slug: input.slug,
        ...(input.status ? { status: input.status } : {}),
        ...(input.fields ? { fields: input.fields } : {}),
      },
      input,
    );
    return { event };
  }

  removeConnector(
    input: {
      projectId: string;
      conversationId: string;
      connectorId: string;
      slug: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'connector.removed',
        input.projectId,
        input.conversationId,
        { connectorId: input.connectorId, slug: input.slug },
        input,
      ),
    };
  }

  /** Connect (create-or-mark) a provider account. Never sets a secret value. */
  connectProviderAccount(
    input: {
      projectId: string;
      conversationId: string;
      provider: string;
      authMode: AuthMode;
      accountId?: string;
    } & EntityWriteOpts,
  ): { accountId: string; event: AmritaEvent } {
    const accountId = input.accountId ?? newId();
    const event = this.emit(
      'provider.connected',
      input.projectId,
      input.conversationId,
      { provider: input.provider, accountId, authMode: input.authMode },
      input,
    );
    return { accountId, event };
  }

  markProviderDegraded(
    input: {
      projectId: string;
      conversationId: string;
      provider: string;
      accountId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'provider.degraded',
        input.projectId,
        input.conversationId,
        { provider: input.provider, accountId: input.accountId, reason: input.reason },
        input,
      ),
    };
  }

  markProviderRestored(
    input: {
      projectId: string;
      conversationId: string;
      provider: string;
      accountId: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'provider.restored',
        input.projectId,
        input.conversationId,
        { provider: input.provider, accountId: input.accountId },
        input,
      ),
    };
  }

  // ── secure config binding (DIRECT update — NOT event-sourced; ADR-0008) ───
  //
  // `secret_ref` is local secure configuration (the NAME of an env var holding a
  // secret), not domain state, and must never enter the event log. These three
  // methods are the *only* sanctioned direct writes to a domain table; they touch
  // `secret_ref` and nothing else. The value is validated as a safe env-NAME and
  // the column's CHECK is the last line of defence. No secret value is ever stored.

  /** Bind an account to the NAME of an env var holding its secret. Never the value. */
  bindAccountSecretRef(accountId: string, envName: string): void {
    if (!isSafeEnvSecretRefName(envName)) {
      throw new Error(
        `refusing to bind: ${JSON.stringify(envName)} is not a safe env-var name (expected UPPER_SNAKE_CASE with an underscore, e.g. OPENAI_API_KEY)`,
      );
    }
    const res = this.db
      .prepare('UPDATE accounts SET secret_ref = ?, updated_at = ? WHERE id = ?')
      .run(envName, now(), accountId);
    if (res.changes === 0) throw new Error(`no such account: ${accountId}`);
  }

  /** Remove an account's secret reference. */
  clearAccountSecretRef(accountId: string): void {
    const res = this.db
      .prepare('UPDATE accounts SET secret_ref = NULL, updated_at = ? WHERE id = ?')
      .run(now(), accountId);
    if (res.changes === 0) throw new Error(`no such account: ${accountId}`);
  }

  /** The bound env-var NAME for an account (never a secret value), or null. */
  getAccountSecretRef(accountId: string): string | null {
    const row = this.db
      .prepare('SELECT secret_ref AS r FROM accounts WHERE id = ?')
      .get(accountId) as { r: string | null } | undefined;
    return row?.r ?? null;
  }

  /**
   * Provider readiness, derived from secret-ref binding + health metadata.
   * Never returns a secret value. `undefined` if the account doesn't exist.
   */
  getProviderConfigStatus(accountId: string): ProviderConfigStatus | undefined {
    const row = this.db
      .prepare('SELECT secret_ref AS r, metadata_json AS m FROM accounts WHERE id = ?')
      .get(accountId) as { r: string | null; m: string | null } | undefined;
    if (!row) return undefined;
    if (!row.r) return 'missing_secret_ref';
    const health = (row.m ? (JSON.parse(row.m) as Record<string, unknown>).health : undefined) as
      | string
      | undefined;
    if (health === 'degraded') return 'degraded';
    if (health === 'connected' || health === 'restored') return 'healthy';
    return 'secret_ref_bound';
  }

  // ── public read / query API ──────────────────────────────────────────────

  /** A conversation and all its descendants via `parent_id` lineage. */
  getConversationTree(conversationId: string): ConversationNode[] {
    return this.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM conversations WHERE id = ?
           UNION ALL
           SELECT c.id FROM conversations c JOIN tree t ON c.parent_id = t.id
         )
         SELECT id, project_id AS projectId, title, parent_id AS parentId,
                created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
         FROM conversations WHERE id IN (SELECT id FROM tree)
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as ConversationNode[];
  }

  private static readonly PROJECT_COLS =
    'id, slug, name, root, created_at AS createdAt, updated_at AS updatedAt';

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare(`SELECT ${Store.PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as
      | ProjectRow
      | undefined;
  }

  getProjectBySlug(slug: string): ProjectRow | undefined {
    return this.db.prepare(`SELECT ${Store.PROJECT_COLS} FROM projects WHERE slug = ?`).get(slug) as
      | ProjectRow
      | undefined;
  }

  listProjects(): ProjectRow[] {
    return this.db
      .prepare(`SELECT ${Store.PROJECT_COLS} FROM projects ORDER BY created_at ASC`)
      .all() as ProjectRow[];
  }

  getConversation(id: string): ConversationNode | undefined {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, parent_id AS parentId,
                created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
         FROM conversations WHERE id = ?`,
      )
      .get(id) as ConversationNode | undefined;
  }

  /** Row counts for diagnostics (health). No secret data. */
  stats(): { projects: number; conversations: number; messages: number; events: number } {
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      projects: count('projects'),
      conversations: count('conversations'),
      messages: count('messages'),
      events: count('events'),
    };
  }

  listTasks(
    filters: { projectId?: string; conversationId?: string; status?: TaskStatus } = {},
  ): TaskRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filters.projectId) {
      where.push('project_id = ?');
      vals.push(filters.projectId);
    }
    if (filters.conversationId) {
      where.push('conversation_id = ?');
      vals.push(filters.conversationId);
    }
    if (filters.status) {
      where.push('status = ?');
      vals.push(filters.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, lane_id AS laneId, status, title, body,
                created_at AS createdAt, updated_at AS updatedAt
         FROM tasks ${clause} ORDER BY created_at ASC`,
      )
      .all(...vals) as TaskRow[];
  }

  listDecisions(
    filters: { projectId?: string; conversationId?: string; includeSuperseded?: boolean } = {},
  ): DecisionRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filters.projectId) {
      where.push('project_id = ?');
      vals.push(filters.projectId);
    }
    if (filters.conversationId) {
      where.push('conversation_id = ?');
      vals.push(filters.conversationId);
    }
    if (!filters.includeSuperseded) {
      // "current" = not pointed at by any superseding row
      where.push('id NOT IN (SELECT supersedes_id FROM decisions WHERE supersedes_id IS NOT NULL)');
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, supersedes_id AS supersedesId, text,
                created_at AS createdAt
         FROM decisions ${clause} ORDER BY created_at ASC`,
      )
      .all(...vals) as DecisionRow[];
  }

  /** The supersession chain for a decision: it and everything it (transitively) supersedes. */
  getDecisionHistory(decisionId: string): DecisionRow[] {
    return this.db
      .prepare(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT id, 0 FROM decisions WHERE id = ?
           UNION ALL
           SELECT d.supersedes_id, c.depth + 1 FROM decisions d JOIN chain c ON d.id = c.id
           WHERE d.supersedes_id IS NOT NULL
         )
         SELECT d.id, d.project_id AS projectId, d.conversation_id AS conversationId,
                d.source_message_id AS sourceMessageId, d.supersedes_id AS supersedesId, d.text,
                d.created_at AS createdAt
         FROM decisions d JOIN chain c ON d.id = c.id
         ORDER BY c.depth DESC`,
      )
      .all(decisionId) as DecisionRow[];
  }

  /**
   * Full-text search over memory content (FTS5 `memory_entries_fts`, ADR-0008).
   * The query is tokenized to alphanumeric terms, each matched as a prefix, and
   * results are ranked best-first by bm25. Returns `[]` for an all-punctuation
   * query. Optional `scope`/`projectId` filters narrow the rows.
   */
  searchMemory(
    query: string,
    opts: { scope?: MemoryScope; projectId?: string; limit?: number } = {},
  ): MemoryEntryRow[] {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g);
    if (!terms || terms.length === 0) return [];
    const match = terms.map((t) => `${t}*`).join(' '); // prefix-match each term (implicit AND)
    const where = ['memory_entries_fts MATCH ?'];
    const vals: (string | number)[] = [match];
    if (opts.scope) {
      where.push('m.scope = ?');
      vals.push(opts.scope);
    }
    if (opts.projectId) {
      where.push('m.project_id = ?');
      vals.push(opts.projectId);
    }
    vals.push(opts.limit ?? 20);
    return this.db
      .prepare(
        `SELECT m.id AS id, m.scope AS scope, m.project_id AS projectId, m.content AS content,
                m.char_count AS charCount, m.source AS source, m.source_message_id AS sourceMessageId,
                m.created_at AS createdAt, m.updated_at AS updatedAt
         FROM memory_entries_fts
         JOIN memory_entries m ON m.rowid = memory_entries_fts.rowid
         WHERE ${where.join(' AND ')}
         ORDER BY bm25(memory_entries_fts)
         LIMIT ?`,
      )
      .all(...vals) as MemoryEntryRow[];
  }

  /** A non-secret config value, parsed from its JSON, or `undefined` if unset. */
  getSetting<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json AS v FROM settings WHERE key = ?').get(key) as
      | { v: string }
      | undefined;
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  listConnectors(): ConnectorRow[] {
    return this.db
      .prepare(
        `SELECT id, slug, kind, status, manifest_json AS manifestJson, config_json AS configJson,
                created_at AS createdAt, updated_at AS updatedAt
         FROM connectors ORDER BY created_at ASC`,
      )
      .all() as ConnectorRow[];
  }

  getConnector(slug: string): ConnectorRow | undefined {
    return this.db
      .prepare(
        `SELECT id, slug, kind, status, manifest_json AS manifestJson, config_json AS configJson,
                created_at AS createdAt, updated_at AS updatedAt
         FROM connectors WHERE slug = ?`,
      )
      .get(slug) as ConnectorRow | undefined;
  }

  /** Accounts. `secretRef` is an env-NAME reference, never a secret value. */
  listAccounts(): AccountRow[] {
    return this.db
      .prepare(
        `SELECT id, provider, label, auth_mode AS authMode, secret_ref AS secretRef,
                metadata_json AS metadataJson, created_at AS createdAt, updated_at AS updatedAt
         FROM accounts ORDER BY created_at ASC`,
      )
      .all() as AccountRow[];
  }

  getAccountHealth(accountId: string): AccountHealth | undefined {
    const row = this.db
      .prepare('SELECT metadata_json AS m FROM accounts WHERE id = ?')
      .get(accountId) as { m: string | null } | undefined;
    if (!row) return undefined;
    const meta = (row.m ? JSON.parse(row.m) : {}) as Record<string, unknown>;
    return {
      health: (meta.health as string | undefined) ?? null,
      healthReason: (meta.healthReason as string | undefined) ?? null,
      healthAt: (meta.healthAt as string | undefined) ?? null,
    };
  }

  listLanes(
    filters: { projectId?: string; conversationId?: string; status?: LaneStatus } = {},
  ): LaneRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filters.projectId) {
      where.push('project_id = ?');
      vals.push(filters.projectId);
    }
    if (filters.conversationId) {
      where.push('conversation_id = ?');
      vals.push(filters.conversationId);
    }
    if (filters.status) {
      where.push('status = ?');
      vals.push(filters.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId, kind, status,
                mandate_json AS mandateJson, budget_json AS budgetJson, merge_json AS mergeJson,
                created_at AS createdAt, updated_at AS updatedAt
         FROM lanes ${clause} ORDER BY created_at ASC`,
      )
      .all(...vals) as LaneRow[];
  }
}

/** Open (creating + migrating if needed) the Amrita store. */
export function openStore(opts: OpenStoreOptions): Store {
  return new Store(opts);
}

export type { EventType };
