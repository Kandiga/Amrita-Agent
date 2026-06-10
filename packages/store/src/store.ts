import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type AmritaEvent,
  type ConversationRow,
  type EventType,
  type MessageRow,
  type ProjectRow,
  type UnsealedEvent,
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
  channel?: 'web' | 'telegram' | 'cli' | 'api';
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

  createConversation(input: { projectId: string; title?: string }): ConversationRow {
    const ts = now();
    const row: ConversationRow = {
      id: newId(),
      projectId: input.projectId,
      title: input.title ?? null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, created_at, updated_at, archived_at)
         VALUES (@id, @projectId, @title, @createdAt, @updatedAt, @archivedAt)`,
      )
      .run(row);
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

  /** Spill a large tool.completed result to a file + artifact row; return the rewritten payload. */
  private maybeSpill(ev: UnsealedEvent): UnsealedEvent['payload'] {
    if (ev.type !== 'tool.completed') return ev.payload;
    const payload = ev.payload as {
      toolCallId: string;
      result: { result?: unknown; isError?: boolean };
    };
    const serialized = JSON.stringify(payload.result.result ?? null);
    if (Buffer.byteLength(serialized, 'utf8') <= SPILL_THRESHOLD_BYTES) return ev.payload;

    const artifactId = newId();
    mkdirSync(this.spillDir, { recursive: true });
    const filePath = join(this.spillDir, `${artifactId}.json`);
    writeFileSync(filePath, serialized);
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
      toolCallId: payload.toolCallId,
      result: {
        spilledArtifactId: artifactId,
        preview: serialized.slice(0, 500),
        isError: payload.result.isError ?? false,
      },
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
    const tx = this.db.transaction((): AmritaEvent => {
      const seq = this.nextSeq(unsealed.conversationId);
      const payload = this.maybeSpill(unsealed);
      const sealed = parseEvent({ ...unsealed, seq, payload });
      this.insertEventRow(sealed);
      applyEventProjection(this.db, sealed); // same-transaction read-model projection
      this.touchConversation(unsealed.conversationId);
      return sealed;
    });
    return tx();
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
}

/** Open (creating + migrating if needed) the Amrita store. */
export function openStore(opts: OpenStoreOptions): Store {
  return new Store(opts);
}

export type { EventType };
