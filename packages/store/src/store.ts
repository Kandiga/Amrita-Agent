import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AmritaEvent,
  type AuthMode,
  type Certainty,
  type ConnectorStatus,
  type ConversationRow,
  type DecisionRight,
  type Derivation,
  type EventChannel,
  type EventOrigin,
  type EventType,
  type InboxConfidence,
  type InboxKind,
  type InboxOrigin,
  type InboxStatus,
  type LaneRowStatus,
  type MemoryScope,
  type MessageRow,
  type MilestoneStatus,
  type ProjectConstraint,
  type ProjectRow,
  type ProviderConfigStatus,
  type QuestionStatus,
  type RiskSeverity,
  type TaskPriority,
  type TaskStatus,
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

function isCorruptionError(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  const msg = (err as Error)?.message ?? '';
  return (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_NOTADB' ||
    /malformed|not a database|file is encrypted/i.test(msg)
  );
}

/**
 * Open the DB, but if the file is CORRUPT/not-a-database, move it aside and throw
 * a clear message instead of crash-looping (ST3). SQLite opens lazily, so a cheap
 * probe forces it to read the header/schema and surface corruption here rather
 * than mid-migration. Quarantining the file (and its WAL sidecars) means the next
 * restart starts from a fresh store while the corrupt image is kept for recovery.
 */
function openDatabaseOrQuarantine(path: string): DB {
  const db = new Database(path);
  try {
    db.exec('SELECT 1');
    db.pragma('schema_version');
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      /* handle already unusable */
    }
    if (path !== ':memory:' && isCorruptionError(err)) {
      const stamp = Date.now();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          renameSync(`${path}${suffix}`, `${path}${suffix}.corrupt.${stamp}`);
        } catch {
          /* sidecar may not exist; best effort */
        }
      }
      const code = (err as { code?: string }).code ?? 'unknown';
      throw new Error(
        `store: database at ${path} is corrupt (${code}); moved aside to ${path}.corrupt.${stamp} — restart to begin from a fresh store, and keep the quarantined file for recovery`,
      );
    }
    throw err;
  }
}

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

// Status enums are protocol-owned since ADR-0032; re-exported for store consumers.
export type {
  AuthMode,
  Certainty,
  ConnectorStatus,
  DecisionRight,
  Derivation,
  ProjectConstraint,
  InboxConfidence,
  InboxKind,
  InboxOrigin,
  InboxStatus,
  MemoryScope,
  MilestoneStatus,
  ProviderConfigStatus,
  QuestionStatus,
  RiskSeverity,
  TaskPriority,
  TaskStatus,
};
export type LaneStatus = LaneRowStatus;

export interface TaskRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  laneId: string | null;
  milestoneId: string | null;
  status: TaskStatus;
  title: string;
  body: string | null;
  /** The board (ADR-0044). Free-text owner: Amrita has no user table. */
  owner: string | null;
  dueDate: string | null;
  priority: TaskPriority | null;
  /** Lexicographic fractional index — a drag is ONE event touching ONE row. */
  orderKey: string | null;
  /** Non-null IS the "Waiting" column. The status enum is deliberately not widened. */
  blockedReason: string | null;
  /** Fact vs hypothesis (ADR-0045). `inferred` = Amrita worked it out. */
  certainty: Certainty | null;
  /** The phase this task lives in (ADR-0045) — the board's columns come from these. */
  phaseId: string | null;
  /** Optimistic-lock token (ADR-0045). Monotonic; a timestamp would collide. */
  version: number;
  /** Why this card exists (ADR-0045) — the goal/constraint/decision it came from. */
  derivedFrom: Derivation[];
  /** Provenance to an external system, e.g. `github:owner/repo#123` (ADR-0022). */
  externalRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A live publication of the public hub (ADR-0045). */
export interface PublicationRow {
  projectId: string;
  publicSlug: string;
  contentHash: string;
  publishedAt: string;
  revokedAt: string | null;
}

/** A phase — the project's own shape, which the board's columns come from (ADR-0045). */
export interface PhaseRow {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  orderKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A proposal awaiting triage — the one queue for agent, lane and human capture (ADR-0044). */
export interface InboxItemRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  origin: InboxOrigin;
  text: string;
  suggestedKind: InboxKind | null;
  /** The proposed command payload; validated against the real command at triage. */
  suggested: Record<string, unknown> | null;
  rationale: string | null;
  confidence: InboxConfidence | null;
  status: InboxStatus;
  /** Non-null exactly when triaged — the SQL CHECK enforces it. */
  promotedKind: InboxKind | null;
  promotedId: string | null;
  /** Non-null exactly when dismissed — the SQL CHECK enforces it. */
  dismissReason: string | null;
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

/** The project brief — one upsert-document row per project (ADR-0018). */
export interface ProjectBriefRow {
  projectId: string;
  goal: string;
  audience: string | null;
  successCriteria: string[];
  scope: string[];
  noScope: string[];
  /** The charter (ADR-0044) — "done means [this]". */
  finishLine: string | null;
  /** The money/dates/policy the plan must live within. `hard` = not negotiable. */
  constraints: ProjectConstraint[];
  /** Who approves what. Free text — Amrita has no user table. */
  decisionRights: DecisionRight[];
  /** Per-field certainty (ADR-0045): `{goal:'stated', finishLine:'inferred'}`. */
  certainty: Record<string, Certainty>;
  /** Optimistic-lock token (ADR-0045). */
  version: number;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OpenQuestionRow {
  id: string;
  certainty?: Certainty | null;
  projectId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  text: string;
  status: QuestionStatus;
  resolution: string | null;
  resolvedByDecisionId: string | null;
  dropReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RiskRow {
  id: string;
  projectId: string;
  conversationId: string | null;
  sourceMessageId: string | null;
  text: string;
  severity: RiskSeverity | null;
  status: QuestionStatus;
  resolution: string | null;
  resolvedByDecisionId: string | null;
  dropReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneRow {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  targetDate: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-project brand memory — one upsert-document row (ADR-0020). */
export interface ProjectBrandRow {
  projectId: string;
  name: string | null;
  audience: string | null;
  tone: string | null;
  styleNotes: string[];
  palette: string[];
  typography: string | null;
  doNotUse: string[];
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A durable approval of a deterministic preview's content hash (ADR-0020). */
export interface PreviewApprovalRow {
  projectId: string;
  previewId: string;
  contentHash: string;
  sourceMessageId: string | null;
  approvedAt: string;
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

export interface PairingRow {
  code: string;
  channel: string;
  projectId: string;
  conversationId: string | null;
  claimedBy: string | null;
  createdAt: string;
  claimedAt: string | null;
}
export interface ChannelLink {
  projectId: string;
  conversationId: string | null;
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
  private readonly listeners = new Set<(ev: AmritaEvent) => void>();

  constructor(opts: OpenStoreOptions) {
    this.db = openDatabaseOrQuarantine(opts.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.spillDir =
      opts.spillDir ?? join(opts.path === ':memory:' ? '.' : dirname(opts.path), 'artifacts');
    migrateUp(this.db);
  }

  close(): void {
    this.listeners.clear();
    this.db.close();
  }

  /**
   * Subscribe to events as they are appended (called POST-commit with the sealed
   * event). Returns an unsubscribe function. Listener errors are swallowed so a
   * bad subscriber can never break a write. Used for live WS fan-out.
   */
  subscribe(listener: (ev: AmritaEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emitAppended(ev: AmritaEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        // a subscriber must never break the write path
      }
    }
  }

  // ── projects & conversations ────────────────────────────────────────────

  createProject(input: { slug: string; name: string; root?: string }): ProjectRow {
    const ts = now();
    const row: ProjectRow = {
      id: newId(),
      slug: input.slug,
      name: input.name,
      root: input.root ?? null,
      activatedAt: null, // ADR-0045: a conversation, not yet a plan
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

  /**
   * Delete a project and EVERYTHING it owns in one transaction (ADR-0038).
   * The single sanctioned destructive verb: events, messages, conversations,
   * companion rows, project memory, lanes, tasks, decisions — all gone,
   * atomically. Other projects' rows are untouched. Not recoverable.
   */
  deleteProject(projectId: string): { deleted: true } {
    const run = this.db.transaction(() => {
      // open the append-only gate for THIS project only (see migration 0008);
      // cleared before commit, so the gate never outlives the transaction.
      this.db
        .prepare(
          "INSERT INTO settings (key, value_json, updated_at) VALUES ('cascade.project.delete', ?, ?) " +
            'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
        )
        .run(JSON.stringify(projectId), now());
      const convIds = (
        this.db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(projectId) as {
          id: string;
        }[]
      ).map((r) => r.id);
      const inConv = `(${convIds.map(() => '?').join(',')})`;
      if (convIds.length > 0) {
        this.db.prepare(`DELETE FROM events WHERE conversation_id IN ${inConv}`).run(...convIds);
        this.db.prepare(`DELETE FROM messages WHERE conversation_id IN ${inConv}`).run(...convIds);
        this.db
          .prepare(`DELETE FROM channel_pairings WHERE conversation_id IN ${inConv}`)
          .run(...convIds);
        this.db.prepare(`DELETE FROM artifacts WHERE conversation_id IN ${inConv}`).run(...convIds);
      }
      for (const table of [
        'tasks',
        'decisions',
        'open_questions',
        'risks',
        'milestones',
        'project_briefs',
        'project_brands',
        'preview_approvals',
        'memory_entries',
        'lanes',
        'inbox_items', // ADR-0044
        'phases', // ADR-0045
        'project_publications', // ADR-0045
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      }
      this.db.prepare('DELETE FROM channel_pairings WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM conversations WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
      this.db.prepare("DELETE FROM settings WHERE key = 'cascade.project.delete'").run();
    });
    run();
    return { deleted: true };
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
    this.emitAppended(sealed); // post-commit notify (live fan-out)
    return sealed;
  }

  /**
   * Replay the ENTIRE event log into the event-derived read model (ADR-0044).
   *
   * This is the executable proof of the "views are projections" invariant: the
   * reducer is pure and clock-free (every timestamp comes from `ev.ts`, see
   * project.ts), so re-applying the log must reproduce the read model exactly.
   * It is also the prerequisite for introducing any NEW projection — without it,
   * a new table would start empty for historical events.
   *
   * Everything happens in ONE transaction: a failing replay rolls the read model
   * back to where it was, so a bug here can never leave a half-rebuilt store.
   *
   * Replay order is `rowid` — the original append order — which is the only
   * ordering that is guaranteed causally correct across conversations (`seq` is
   * per-conversation, so it cannot order the log globally).
   *
   * SCOPE — only tables whose SOLE writer is `applyEventProjection` are rebuilt.
   * `projects`, `conversations` (the rows themselves), `accounts.secret_ref`,
   * `settings`, `channel_pairings` and `artifacts` have sanctioned direct writers
   * (ADR-0007/0008/0013) and are left untouched: they are not derived state, and
   * rebuilding them from the log would delete data the log does not contain.
   */
  rebuildProjections(): { events: number } {
    const rebuild = this.db.transaction((): number => {
      const projectIds = (this.db.prepare('SELECT id FROM projects').all() as { id: string }[]).map(
        (r) => r.id,
      );

      // `decisions` is append-only at the SQL layer. Deleting requires the same
      // per-project gate ADR-0038 built for project.delete — opened for one
      // project at a time and cleared before commit, so the gate is never
      // observable outside this transaction and the trigger is NOT weakened.
      const openGate = this.db.prepare(
        "INSERT INTO settings (key, value_json, updated_at) VALUES ('cascade.project.delete', ?, ?) " +
          'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      );
      for (const projectId of projectIds) {
        openGate.run(JSON.stringify(projectId), now());
        this.db.prepare('DELETE FROM decisions WHERE project_id = ?').run(projectId);
      }
      this.db.prepare("DELETE FROM settings WHERE key = 'cascade.project.delete'").run();

      // Child-first, so an ON DELETE SET NULL FK never blanks a column on a row
      // we are about to re-project anyway. `messages` goes last: tasks/decisions
      // point at it via source_message_id.
      for (const table of [
        'preview_approvals',
        'project_brands',
        'project_briefs',
        'lanes',
        'connectors',
        'memory_entries',
        'inbox_items', // ADR-0044
        'project_publications', // ADR-0045
        'risks',
        'open_questions',
        'tasks',
        'phases', // ADR-0045 — after tasks (the phase trigger checks existence)
        'milestones',
        'messages',
      ]) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      // `conversations.archived_at` is projected from `conversation.archived`;
      // the row itself is not. Reset just the projected column.
      this.db.prepare('UPDATE conversations SET archived_at = NULL').run();
      // `projects.activated_at` is projected from `project.activated`; the row is not.
      this.db.prepare('UPDATE projects SET activated_at = NULL').run();

      const rows = this.db.prepare('SELECT * FROM events ORDER BY rowid ASC').all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        applyEventProjection(this.db, rowToEvent(row));
      }
      return rows.length;
    });
    return { events: rebuild() };
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

  /**
   * Record an assistant message — a `message.agent` event whose projection
   * materializes the `messages` row (role `agent`, id == event id) atomically,
   * exactly like {@link recordUserMessage}. Used by the chat turn runtime.
   */
  recordAgentMessage(input: {
    projectId: string;
    conversationId: string;
    text: string;
    turnId?: string;
    channel?: EventChannel;
  }): { message: MessageRow; event: AmritaEvent } {
    const event = this.appendEvent({
      id: newId(),
      ts: now(),
      projectId: input.projectId,
      conversationId: input.conversationId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      origin: 'agent',
      type: 'message.agent',
      payload: { text: input.text },
    });
    const message: MessageRow = {
      id: event.id,
      conversationId: input.conversationId,
      turnId: input.turnId ?? null,
      role: 'agent',
      text: input.text,
      createdAt: event.ts,
    };
    return { message, event };
  }

  /** Recent messages in a conversation (oldest-first), for context assembly. */
  listMessages(conversationId: string, opts: { limit?: number } = {}): MessageRow[] {
    return this.db
      .prepare(
        `SELECT id, conversation_id AS conversationId, turn_id AS turnId, role,
                json_extract(content_json, '$.text') AS text, created_at AS createdAt
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(conversationId, opts.limit ?? 200) as MessageRow[];
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

  /**
   * The project timeline — a bounded, newest-first read of the event log across
   * ALL of a project's conversations (ADR-0018). Derived, never stored: the log
   * IS the activity feed. `rowid` breaks ties for events sharing a timestamp.
   */
  listProjectEvents(projectId: string, opts: { limit?: number } = {}): AmritaEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.db
      .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?')
      .all(projectId, limit) as Record<string, unknown>[];
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
      milestoneId?: string;
      body?: string;
      externalRef?: string;
      owner?: string;
      dueDate?: string;
      priority?: TaskPriority;
      orderKey?: string;
      blockedReason?: string;
      certainty?: Certainty;
      phaseId?: string;
      derivedFrom?: Derivation[];
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
        ...(input.milestoneId ? { milestoneId: input.milestoneId } : {}),
        title: input.title,
        ...(input.status ? { status: input.status } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.externalRef ? { externalRef: input.externalRef } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.orderKey ? { orderKey: input.orderKey } : {}),
        ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
        ...(input.certainty ? { certainty: input.certainty } : {}),
        ...(input.phaseId ? { phaseId: input.phaseId } : {}),
        ...(input.derivedFrom?.length ? { derivedFrom: input.derivedFrom } : {}),
      },
      input,
    );
    return { taskId, event };
  }

  getTask(taskId: string): TaskRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, lane_id AS laneId,
                milestone_id AS milestoneId, status, title, body,
                owner, due_date AS dueDate, priority, order_key AS orderKey,
                blocked_reason AS blockedReason, certainty, phase_id AS phaseId, version,
                derived_from_json AS dfj, external_ref AS externalRef,
                created_at AS createdAt, updated_at AS updatedAt
           FROM tasks WHERE id = ?`,
      )
      .get(taskId) as (Omit<TaskRow, 'derivedFrom'> & { dfj: string }) | undefined;
    if (!row) return undefined;
    const { dfj, ...rest } = row;
    return { ...rest, derivedFrom: JSON.parse(dfj) as Derivation[] };
  }

  /**
   * Optimistic concurrency (ADR-0045).
   *
   * The caller sends the `version` it last SAW. If the row has moved on since,
   * someone else changed it and this write is stale — so we refuse it and say so,
   * rather than silently overwriting their work. Two operators dragging the same
   * card, or a Scribe write racing a human edit, must never end in a quiet loss.
   *
   * The token is a monotonic COUNTER, not a timestamp: `updated_at` has millisecond
   * resolution, so two writes in the same millisecond would carry the same token and
   * a stale write would sail straight through the guard meant to stop it. (This was
   * a real bug in the first cut, caught by a test.)
   *
   * The read-then-write is atomic in practice: better-sqlite3 is synchronous and the
   * daemon is single-threaded, so nothing can interleave between the check and the
   * append inside one synchronous method.
   *
   * `conflict:` is the prefix the RPC layer maps to the `conflict` error code.
   */
  private assertFresh(
    kind: string,
    id: string,
    actual: number | undefined,
    expected: number | undefined,
  ): void {
    if (expected === undefined) return; // caller opted out (CLI, agent, migration)
    if (actual === undefined) throw new Error(`no such ${kind}: ${id}`);
    if (actual !== expected) {
      throw new Error(
        `conflict: this ${kind} was changed by someone else (you saw v${expected}, it is now v${actual}) — reload and reapply`,
      );
    }
  }

  /**
   * Update a task (ADR-0018 + the board fields of ADR-0044).
   *
   * For every field: **absent = leave it alone, `null` = clear it.** That is what
   * lets the board un-assign an owner or unblock a task without a second verb.
   *
   * `expectedUpdatedAt` (ADR-0045) makes the write optimistic-locked: a stale
   * update is REFUSED, never silently applied.
   */
  updateTask(
    input: {
      projectId: string;
      conversationId: string;
      taskId: string;
      status?: TaskStatus;
      title?: string;
      body?: string;
      /** A milestone to link to, or `null` to unlink (ADR-0018). */
      milestoneId?: string | null;
      owner?: string | null;
      dueDate?: string | null;
      priority?: TaskPriority | null;
      orderKey?: string;
      blockedReason?: string | null;
      certainty?: Certainty | null;
      phaseId?: string | null;
      derivedFrom?: Derivation[];
      /** WHY the change was made (ADR-0045). Lives on the event, not the row. */
      reason?: string;
      /** The row `version` the caller last saw. Mismatch ⇒ `conflict`, not a silent overwrite. */
      expectedVersion?: number;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const before = this.getTask(input.taskId);
    this.assertFresh('task', input.taskId, before?.version, input.expectedVersion);

    // ADR-0045: "מאיזה מצב לאיזה מצב" — capture the FROM side, for exactly the
    // fields this update touches, so the event explains itself without a replay.
    const previous: Record<string, unknown> = {};
    if (before) {
      if (input.status !== undefined && input.status !== before.status)
        previous.status = before.status;
      if (input.phaseId !== undefined && input.phaseId !== before.phaseId)
        previous.phaseId = before.phaseId;
      if (input.owner !== undefined && input.owner !== before.owner) previous.owner = before.owner;
      if (input.priority !== undefined && input.priority !== before.priority)
        previous.priority = before.priority;
      if (input.blockedReason !== undefined && input.blockedReason !== before.blockedReason)
        previous.blockedReason = before.blockedReason;
      if (input.milestoneId !== undefined && input.milestoneId !== before.milestoneId)
        previous.milestoneId = before.milestoneId;
    }

    const event = this.emit(
      'task.updated',
      input.projectId,
      input.conversationId,
      {
        taskId: input.taskId,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.milestoneId !== undefined ? { milestoneId: input.milestoneId } : {}),
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.orderKey !== undefined ? { orderKey: input.orderKey } : {}),
        ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
        ...(input.certainty !== undefined ? { certainty: input.certainty } : {}),
        ...(input.phaseId !== undefined ? { phaseId: input.phaseId } : {}),
        ...(input.derivedFrom !== undefined ? { derivedFrom: input.derivedFrom } : {}),
        ...(Object.keys(previous).length > 0 ? { previous } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
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

  // ── project companion (ADR-0018) ──────────────────────────────────────────

  /** Create or replace the project brief (a full-document upsert). */
  upsertBrief(
    input: {
      projectId: string;
      conversationId: string;
      goal: string;
      audience?: string;
      successCriteria?: string[];
      scope?: string[];
      noScope?: string[];
      finishLine?: string;
      constraints?: ProjectConstraint[];
      decisionRights?: DecisionRight[];
      certainty?: Record<string, Certainty>;
      sourceMessageId?: string;
      /**
       * The row `version` the caller last saw (ADR-0045). The brief is a FULL-document
       * upsert, so a stale write does not just lose a field — it WIPES the charter
       * someone else just wrote. This is the most dangerous stale write in the system.
       */
      expectedVersion?: number;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    this.assertFresh(
      'brief',
      input.projectId,
      this.getBrief(input.projectId)?.version,
      input.expectedVersion,
    );
    const event = this.emit(
      'brief.updated',
      input.projectId,
      input.conversationId,
      {
        projectId: input.projectId,
        goal: input.goal,
        ...(input.audience ? { audience: input.audience } : {}),
        successCriteria: input.successCriteria ?? [],
        scope: input.scope ?? [],
        noScope: input.noScope ?? [],
        ...(input.finishLine ? { finishLine: input.finishLine } : {}),
        ...(input.constraints ? { constraints: input.constraints } : {}),
        ...(input.decisionRights ? { decisionRights: input.decisionRights } : {}),
        ...(input.certainty ? { certainty: input.certainty } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      },
      input,
    );
    return { event };
  }

  /** Create or replace the project brand document (full-document upsert, ADR-0020). */
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
  ): { event: AmritaEvent } {
    const event = this.emit(
      'brand.updated',
      input.projectId,
      input.conversationId,
      {
        projectId: input.projectId,
        ...(input.name ? { name: input.name } : {}),
        ...(input.audience ? { audience: input.audience } : {}),
        ...(input.tone ? { tone: input.tone } : {}),
        styleNotes: input.styleNotes ?? [],
        palette: input.palette ?? [],
        ...(input.typography ? { typography: input.typography } : {}),
        doNotUse: input.doNotUse ?? [],
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      },
      input,
    );
    return { event };
  }

  /** Approve (or re-approve) a preview's content hash for a project (ADR-0020). */
  approvePreview(
    input: {
      projectId: string;
      conversationId: string;
      previewId: string;
      contentHash: string;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'preview.approved',
      input.projectId,
      input.conversationId,
      {
        previewId: input.previewId,
        projectId: input.projectId,
        contentHash: input.contentHash,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      },
      input,
    );
    return { event };
  }

  openQuestion(
    input: {
      projectId: string;
      conversationId: string;
      text: string;
      certainty?: Certainty;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { questionId: string; event: AmritaEvent } {
    const questionId = newId();
    const event = this.emit(
      'question.opened',
      input.projectId,
      input.conversationId,
      {
        questionId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        text: input.text,
        ...(input.certainty ? { certainty: input.certainty } : {}),
      },
      input,
    );
    return { questionId, event };
  }

  /** Resolve a question with a note and/or a decision link (at least one — enforced). */
  resolveQuestion(
    input: {
      projectId: string;
      conversationId: string;
      questionId: string;
      resolution?: string;
      resolvedByDecisionId?: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'question.resolved',
      input.projectId,
      input.conversationId,
      {
        questionId: input.questionId,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.resolvedByDecisionId ? { resolvedByDecisionId: input.resolvedByDecisionId } : {}),
      },
      input,
    );
    return { event };
  }

  dropQuestion(
    input: {
      projectId: string;
      conversationId: string;
      questionId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'question.dropped',
      input.projectId,
      input.conversationId,
      { questionId: input.questionId, reason: input.reason },
      input,
    );
    return { event };
  }

  openRisk(
    input: {
      projectId: string;
      conversationId: string;
      text: string;
      severity?: RiskSeverity;
      certainty?: Certainty;
      sourceMessageId?: string;
    } & EntityWriteOpts,
  ): { riskId: string; event: AmritaEvent } {
    const riskId = newId();
    const event = this.emit(
      'risk.opened',
      input.projectId,
      input.conversationId,
      {
        riskId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        text: input.text,
        ...(input.severity ? { severity: input.severity } : {}),
        ...(input.certainty ? { certainty: input.certainty } : {}),
      },
      input,
    );
    return { riskId, event };
  }

  resolveRisk(
    input: {
      projectId: string;
      conversationId: string;
      riskId: string;
      resolution?: string;
      resolvedByDecisionId?: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'risk.resolved',
      input.projectId,
      input.conversationId,
      {
        riskId: input.riskId,
        ...(input.resolution ? { resolution: input.resolution } : {}),
        ...(input.resolvedByDecisionId ? { resolvedByDecisionId: input.resolvedByDecisionId } : {}),
      },
      input,
    );
    return { event };
  }

  dropRisk(
    input: {
      projectId: string;
      conversationId: string;
      riskId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    const event = this.emit(
      'risk.dropped',
      input.projectId,
      input.conversationId,
      { riskId: input.riskId, reason: input.reason },
      input,
    );
    return { event };
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
  ): { milestoneId: string; event: AmritaEvent } {
    const milestoneId = newId();
    const event = this.emit(
      'milestone.created',
      input.projectId,
      input.conversationId,
      {
        milestoneId,
        projectId: input.projectId,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.targetDate ? { targetDate: input.targetDate } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      input,
    );
    return { milestoneId, event };
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
  ): { event: AmritaEvent } {
    const event = this.emit(
      'milestone.updated',
      input.projectId,
      input.conversationId,
      {
        milestoneId: input.milestoneId,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
      },
      input,
    );
    return { event };
  }

  completeMilestone(
    input: { projectId: string; conversationId: string; milestoneId: string } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'milestone.completed',
        input.projectId,
        input.conversationId,
        { milestoneId: input.milestoneId },
        input,
      ),
    };
  }

  // ── phases + activation (ADR-0045) ──────────────────────────────────────────

  createPhase(
    input: {
      projectId: string;
      conversationId: string;
      title: string;
      description?: string;
      status?: MilestoneStatus;
      orderKey?: string;
    } & EntityWriteOpts,
  ): { phaseId: string; event: AmritaEvent } {
    const phaseId = newId();
    const event = this.emit(
      'phase.created',
      input.projectId,
      input.conversationId,
      {
        phaseId,
        projectId: input.projectId,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.orderKey ? { orderKey: input.orderKey } : {}),
      },
      input,
    );
    return { phaseId, event };
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
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'phase.updated',
        input.projectId,
        input.conversationId,
        {
          phaseId: input.phaseId,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.orderKey !== undefined ? { orderKey: input.orderKey } : {}),
        },
        input,
      ),
    };
  }

  listPhases(projectId: string): PhaseRow[] {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, description, status,
                order_key AS orderKey, created_at AS createdAt, updated_at AS updatedAt
           FROM phases WHERE project_id = ?
          ORDER BY order_key IS NULL, order_key ASC, created_at ASC, rowid ASC`,
      )
      .all(projectId) as PhaseRow[];
  }

  /**
   * Mark the project ACTIVATED (ADR-0045). The project stops being a conversation
   * and becomes a plan — but only ever because the operator said so.
   */
  activateProject(
    input: {
      projectId: string;
      conversationId: string;
      phaseCount: number;
      milestoneCount: number;
      taskCount: number;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'project.activated',
        input.projectId,
        input.conversationId,
        {
          projectId: input.projectId,
          phaseCount: input.phaseCount,
          milestoneCount: input.milestoneCount,
          taskCount: input.taskCount,
        },
        input,
      ),
    };
  }

  // ── the public hub (ADR-0045) ───────────────────────────────────────────────

  publishHub(
    input: {
      projectId: string;
      conversationId: string;
      publicSlug: string;
      contentHash: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'publication.published',
        input.projectId,
        input.conversationId,
        {
          projectId: input.projectId,
          publicSlug: input.publicSlug,
          contentHash: input.contentHash,
        },
        input,
      ),
    };
  }

  revokeHub(
    input: { projectId: string; conversationId: string; reason: string } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'publication.revoked',
        input.projectId,
        input.conversationId,
        { projectId: input.projectId, reason: input.reason },
        input,
      ),
    };
  }

  getPublication(projectId: string): PublicationRow | undefined {
    return this.db
      .prepare(
        `SELECT project_id AS projectId, public_slug AS publicSlug, content_hash AS contentHash,
                published_at AS publishedAt, revoked_at AS revokedAt
           FROM project_publications WHERE project_id = ?`,
      )
      .get(projectId) as PublicationRow | undefined;
  }

  // ── the Inbox — the one triage queue (ADR-0044) ─────────────────────────────

  /**
   * Capture a PROPOSAL. Whoever raised it — a human quick-capture, the Scribe
   * (`origin: 'agent'`), or a lane merge report (`origin: 'lane'`) — it lands in
   * the same queue and is not project truth until someone triages it.
   */
  captureInboxItem(
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
  ): { itemId: string; event: AmritaEvent } {
    const itemId = newId();
    const event = this.emit(
      'inbox.captured',
      input.projectId,
      input.conversationId,
      {
        itemId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        origin: input.origin,
        text: input.text,
        ...(input.suggestedKind ? { suggestedKind: input.suggestedKind } : {}),
        ...(input.suggested ? { suggested: input.suggested } : {}),
        ...(input.rationale ? { rationale: input.rationale } : {}),
        ...(input.confidence ? { confidence: input.confidence } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      },
      input,
    );
    return { itemId, event };
  }

  /**
   * Record that an item was promoted into a real aggregate. The CALLER performs
   * the promotion (by calling the real typed command) and passes back what it
   * became — so the Inbox never becomes a second write path into the domain.
   */
  triageInboxItem(
    input: {
      projectId: string;
      conversationId: string;
      itemId: string;
      promotedKind: InboxKind;
      promotedId: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'inbox.triaged',
        input.projectId,
        input.conversationId,
        {
          itemId: input.itemId,
          promotedKind: input.promotedKind,
          promotedId: input.promotedId,
        },
        input,
      ),
    };
  }

  /** Dismiss with a reason — nothing leaves the queue silently. */
  dismissInboxItem(
    input: {
      projectId: string;
      conversationId: string;
      itemId: string;
      reason: string;
    } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    return {
      event: this.emit(
        'inbox.dismissed',
        input.projectId,
        input.conversationId,
        { itemId: input.itemId, reason: input.reason },
        input,
      ),
    };
  }

  listInboxItems(filters: { projectId: string; status?: InboxStatus }): InboxItemRow[] {
    const where = filters.status ? 'WHERE project_id = ? AND status = ?' : 'WHERE project_id = ?';
    const args = filters.status ? [filters.projectId, filters.status] : [filters.projectId];
    const rows = this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, origin, text,
                suggested_kind AS suggestedKind, suggested_json AS suggestedJson,
                rationale, confidence, status, promoted_kind AS promotedKind,
                promoted_id AS promotedId, dismiss_reason AS dismissReason,
                created_at AS createdAt, updated_at AS updatedAt
           FROM inbox_items ${where} ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...args) as (Omit<InboxItemRow, 'suggested'> & { suggestedJson: string | null })[];
    return rows.map(({ suggestedJson, ...r }) => ({
      ...r,
      suggested: suggestedJson ? (JSON.parse(suggestedJson) as Record<string, unknown>) : null,
    }));
  }

  getInboxItem(itemId: string): InboxItemRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, origin, text,
                suggested_kind AS suggestedKind, suggested_json AS suggestedJson,
                rationale, confidence, status, promoted_kind AS promotedKind,
                promoted_id AS promotedId, dismiss_reason AS dismissReason,
                created_at AS createdAt, updated_at AS updatedAt
           FROM inbox_items WHERE id = ?`,
      )
      .get(itemId) as
      | (Omit<InboxItemRow, 'suggested'> & { suggestedJson: string | null })
      | undefined;
    if (!row) return undefined;
    const { suggestedJson, ...rest } = row;
    return {
      ...rest,
      suggested: suggestedJson ? (JSON.parse(suggestedJson) as Record<string, unknown>) : null,
    };
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
      label?: string;
    } & EntityWriteOpts,
  ): { accountId: string; event: AmritaEvent } {
    // Idempotent reconnect: (provider, label) is UNIQUE, so connecting the same
    // account twice with a fresh id would raise a raw UNIQUE violation surfaced as
    // an opaque 'internal' error. When the caller does not pin an id, reuse the
    // existing account for this (provider, label) instead of minting a new one.
    const existing = input.accountId
      ? undefined
      : (this.db
          .prepare('SELECT id FROM accounts WHERE provider = ? AND label IS ?')
          .get(input.provider, input.label ?? null) as { id: string } | undefined);
    const accountId = input.accountId ?? existing?.id ?? newId();
    const event = this.emit(
      'provider.connected',
      input.projectId,
      input.conversationId,
      {
        provider: input.provider,
        accountId,
        authMode: input.authMode,
        ...(input.label ? { label: input.label } : {}),
      },
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
    'id, slug, name, root, activated_at AS activatedAt, created_at AS createdAt, updated_at AS updatedAt';

  /**
   * Set (or clear) a project's working root (ADR-0045).
   *
   * `root` was write-once: it could only be given at `createProject`, and there was
   * no `updateProject` at all — which is exactly why every live project sat at
   * `root = NULL` and the bounded file/git probes had nothing to look at. The path
   * is validated by the CALLER against the allowed-roots allowlist; the store just
   * records it, and the `project.updated` event makes the change auditable.
   */
  setProjectRoot(
    input: { projectId: string; conversationId: string; root: string | null } & EntityWriteOpts,
  ): { event: AmritaEvent } {
    // The audit event and the row mutation must be ONE transaction. They used to be
    // two, so a crash (or a failing UPDATE) between them left the log saying "root
    // changed" while projects.root still held the old value — and the event carries
    // only `{fields:['root']}`, not the value, so the divergence was unreconcilable.
    // Nesting appendEvent's transaction as a savepoint makes them atomic: if the
    // UPDATE throws, the event rolls back too.
    return this.db.transaction(() => {
      const event = this.emit(
        'project.updated',
        input.projectId,
        input.conversationId,
        { fields: ['root'] },
        input,
      );
      this.db
        .prepare('UPDATE projects SET root = ?, updated_at = ? WHERE id = ?')
        .run(input.root, now(), input.projectId);
      return { event };
    })();
  }

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

  listConversations(projectId: string): ConversationNode[] {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, parent_id AS parentId,
                created_at AS createdAt, updated_at AS updatedAt, archived_at AS archivedAt
         FROM conversations WHERE project_id = ? ORDER BY created_at ASC`,
      )
      .all(projectId) as ConversationNode[];
  }

  // ── channel pairings (DIRECT writes — local linking config, ADR-0013) ─────
  //
  // A pairing links an external channel identity to a project+conversation. Like
  // secret_ref binding (ADR-0008) this is config, not event-sourced. `code` is a
  // low-sensitivity pairing token — never a secret/API key/bot token.

  private static readonly PAIRING_COLS =
    'code, channel, project_id AS projectId, conversation_id AS conversationId, claimed_by AS claimedBy, created_at AS createdAt, claimed_at AS claimedAt';

  /** Create an unclaimed pairing for a channel + project/conversation. Returns the code. */
  createPairing(input: {
    channel: string;
    projectId: string;
    conversationId?: string;
    code?: string;
  }): PairingRow {
    const code = input.code ?? newId().slice(-8);
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO channel_pairings (code, channel, project_id, conversation_id, claimed_by, created_at, claimed_at)
         VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(code, input.channel, input.projectId, input.conversationId ?? null, ts);
    return {
      code,
      channel: input.channel,
      projectId: input.projectId,
      conversationId: input.conversationId ?? null,
      claimedBy: null,
      createdAt: ts,
      claimedAt: null,
    };
  }

  /** Claim a pairing code for an external user; returns the linked context. */
  consumePairing(input: { channel: string; code: string; externalUserId: string }): ChannelLink {
    const row = this.db
      .prepare(
        'SELECT project_id AS projectId, conversation_id AS conversationId, claimed_by AS claimedBy FROM channel_pairings WHERE code = ? AND channel = ?',
      )
      .get(input.code, input.channel) as
      | { projectId: string; conversationId: string | null; claimedBy: string | null }
      | undefined;
    if (!row) throw new Error(`unknown pairing code: ${input.code}`);
    if (row.claimedBy) throw new Error(`pairing code already claimed: ${input.code}`);
    this.db
      .prepare('UPDATE channel_pairings SET claimed_by = ?, claimed_at = ? WHERE code = ?')
      .run(input.externalUserId, now(), input.code);
    return { projectId: row.projectId, conversationId: row.conversationId };
  }

  /** The most recently claimed link for a channel identity, or undefined. */
  getChannelLink(channel: string, externalUserId: string): ChannelLink | undefined {
    return this.db
      .prepare(
        `SELECT project_id AS projectId, conversation_id AS conversationId
         FROM channel_pairings WHERE channel = ? AND claimed_by = ?
         ORDER BY claimed_at DESC LIMIT 1`,
      )
      .get(channel, externalUserId) as ChannelLink | undefined;
  }

  listPairings(channel?: string): PairingRow[] {
    const where = channel ? 'WHERE channel = ?' : '';
    const stmt = this.db.prepare(
      `SELECT ${Store.PAIRING_COLS} FROM channel_pairings ${where} ORDER BY created_at ASC`,
    );
    return (channel ? stmt.all(channel) : stmt.all()) as PairingRow[];
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
    const rows = this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, lane_id AS laneId,
                milestone_id AS milestoneId, status, title, body,
                owner, due_date AS dueDate, priority, order_key AS orderKey,
                blocked_reason AS blockedReason, certainty, phase_id AS phaseId, version,
                derived_from_json AS dfj, external_ref AS externalRef,
                created_at AS createdAt, updated_at AS updatedAt
         FROM tasks ${clause}
         -- board order: an explicit key first, then a stable fallback for tasks
         -- that have never been dragged (order_key IS NULL sorts last otherwise)
         ORDER BY order_key IS NULL, order_key ASC, created_at ASC, rowid ASC`,
      )
      .all(...vals) as (Omit<TaskRow, 'derivedFrom'> & { dfj: string })[];
    return rows.map(({ dfj, ...r }) => ({
      ...r,
      derivedFrom: JSON.parse(dfj) as Derivation[],
    }));
  }

  /** The external refs (e.g. `github:owner/repo#N`) already present in a project (ADR-0022). */
  listTaskExternalRefs(projectId: string): Set<string> {
    const rows = this.db
      .prepare(
        'SELECT external_ref AS ref FROM tasks WHERE project_id = ? AND external_ref IS NOT NULL',
      )
      .all(projectId) as { ref: string }[];
    return new Set(rows.map((r) => r.ref));
  }

  // ── project companion reads (ADR-0018) ────────────────────────────────────

  getBrief(projectId: string): ProjectBriefRow | undefined {
    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, goal, audience,
                success_criteria_json AS sc, scope_json AS sj, no_scope_json AS nsj,
                finish_line AS finishLine, constraints_json AS cj, decision_rights_json AS drj,
                certainty_json AS ctj, version,
                source_message_id AS sourceMessageId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM project_briefs WHERE project_id = ?`,
      )
      .get(projectId) as
      | (Omit<
          ProjectBriefRow,
          'successCriteria' | 'scope' | 'noScope' | 'constraints' | 'decisionRights' | 'certainty'
        > & {
          sc: string;
          sj: string;
          nsj: string;
          cj: string;
          drj: string;
          ctj: string;
        })
      | undefined;
    if (!row) return undefined;
    const { sc, sj, nsj, cj, drj, ctj, ...rest } = row;
    return {
      ...rest,
      successCriteria: JSON.parse(sc) as string[],
      scope: JSON.parse(sj) as string[],
      noScope: JSON.parse(nsj) as string[],
      constraints: JSON.parse(cj) as ProjectConstraint[],
      decisionRights: JSON.parse(drj) as DecisionRight[],
      certainty: JSON.parse(ctj) as Record<string, Certainty>,
    };
  }

  getBrand(projectId: string): ProjectBrandRow | undefined {
    const row = this.db
      .prepare(
        `SELECT project_id AS projectId, name, audience, tone,
                style_notes_json AS sn, palette_json AS pj, typography,
                do_not_use_json AS dnu, source_message_id AS sourceMessageId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM project_brands WHERE project_id = ?`,
      )
      .get(projectId) as
      | (Omit<ProjectBrandRow, 'styleNotes' | 'palette' | 'doNotUse'> & {
          sn: string;
          pj: string;
          dnu: string;
        })
      | undefined;
    if (!row) return undefined;
    const { sn, pj, dnu, ...rest } = row;
    return {
      ...rest,
      styleNotes: JSON.parse(sn) as string[],
      palette: JSON.parse(pj) as string[],
      doNotUse: JSON.parse(dnu) as string[],
    };
  }

  listPreviewApprovals(projectId: string): PreviewApprovalRow[] {
    return this.db
      .prepare(
        `SELECT project_id AS projectId, preview_id AS previewId, content_hash AS contentHash,
                source_message_id AS sourceMessageId, approved_at AS approvedAt
         FROM preview_approvals WHERE project_id = ? ORDER BY preview_id ASC`,
      )
      .all(projectId) as PreviewApprovalRow[];
  }

  listQuestions(filters: { projectId?: string; status?: QuestionStatus } = {}): OpenQuestionRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filters.projectId) {
      where.push('project_id = ?');
      vals.push(filters.projectId);
    }
    if (filters.status) {
      where.push('status = ?');
      vals.push(filters.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, text, status, resolution,
                resolved_by_decision_id AS resolvedByDecisionId, drop_reason AS dropReason,
                certainty,
                created_at AS createdAt, updated_at AS updatedAt
         FROM open_questions ${clause} ORDER BY created_at ASC`,
      )
      .all(...vals) as OpenQuestionRow[];
  }

  listRisks(filters: { projectId?: string; status?: QuestionStatus } = {}): RiskRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filters.projectId) {
      where.push('project_id = ?');
      vals.push(filters.projectId);
    }
    if (filters.status) {
      where.push('status = ?');
      vals.push(filters.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId,
                source_message_id AS sourceMessageId, text, severity, status, resolution,
                resolved_by_decision_id AS resolvedByDecisionId, drop_reason AS dropReason,
                certainty,
                created_at AS createdAt, updated_at AS updatedAt
         FROM risks ${clause} ORDER BY created_at ASC`,
      )
      .all(...vals) as RiskRow[];
  }

  listMilestones(filters: { projectId?: string; status?: MilestoneStatus } = {}): MilestoneRow[] {
    const where: string[] = [];
    const vals: string[] = [];
    if (filters.projectId) {
      where.push('project_id = ?');
      vals.push(filters.projectId);
    }
    if (filters.status) {
      where.push('status = ?');
      vals.push(filters.status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, description, status,
                target_date AS targetDate, created_at AS createdAt, updated_at AS updatedAt
         FROM milestones ${clause} ORDER BY created_at ASC`,
      )
      .all(...vals) as MilestoneRow[];
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

  /**
   * All memory entries for a project, newest first (ADR-0027 brain projection).
   * Unlike searchMemory this is an unranked full list, used to derive normalized
   * knowledge records from manually-captured memory.
   */
  listMemoryEntries(projectId: string, opts: { limit?: number } = {}): MemoryEntryRow[] {
    return this.db
      .prepare(
        `SELECT id, scope, project_id AS projectId, content, char_count AS charCount,
                source, source_message_id AS sourceMessageId,
                created_at AS createdAt, updated_at AS updatedAt
         FROM memory_entries
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(projectId, opts.limit ?? 500) as MemoryEntryRow[];
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

  /** A single lane by id (with its mandate/budget/merge JSON), or `undefined`. */
  getLane(id: string): LaneRow | undefined {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, conversation_id AS conversationId, kind, status,
                mandate_json AS mandateJson, budget_json AS budgetJson, merge_json AS mergeJson,
                created_at AS createdAt, updated_at AS updatedAt
         FROM lanes WHERE id = ?`,
      )
      .get(id) as LaneRow | undefined;
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
