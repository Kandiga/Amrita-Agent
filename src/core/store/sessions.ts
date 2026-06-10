import { getDb, hasFts } from './db.ts';
import type { ChatMessage, Session } from '../../shared/types.ts';
import { id, now } from '../../shared/util.ts';

interface SessionRow {
  id: string;
  project_slug: string | null;
  channel_origin: string;
  created_at: number;
  last_active_at: number;
  title: string | null;
  parent_session_id: string | null;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    projectSlug: r.project_slug,
    channelOrigin: r.channel_origin,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    title: r.title,
    parentSessionId: r.parent_session_id,
  };
}

export function createSession(
  projectSlug: string | null,
  channelOrigin: string,
  parentSessionId: string | null = null,
): Session {
  const db = getDb();
  const session: Session = {
    id: id('ses'),
    projectSlug,
    channelOrigin,
    createdAt: now(),
    lastActiveAt: now(),
    title: null,
    parentSessionId,
  };
  db.prepare(
    `INSERT INTO sessions (id, project_slug, channel_origin, created_at, last_active_at, title, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    projectSlug,
    channelOrigin,
    session.createdAt,
    session.lastActiveAt,
    null,
    parentSessionId,
  );
  return session;
}

export function getSession(sessionId: string): Session | null {
  const r = getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as
    | SessionRow
    | undefined;
  return r ? rowToSession(r) : null;
}

export function listSessions(projectSlug: string | null, limit = 30): Session[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions WHERE project_slug IS ? ORDER BY last_active_at DESC LIMIT ?`,
    )
    .all(projectSlug, limit) as unknown as SessionRow[];
  return rows.map(rowToSession);
}

export function touchSession(sessionId: string, title?: string): void {
  if (title !== undefined) {
    getDb()
      .prepare(`UPDATE sessions SET last_active_at = ?, title = COALESCE(title, ?) WHERE id = ?`)
      .run(now(), title, sessionId);
  } else {
    getDb().prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(now(), sessionId);
  }
}

export function appendMessage(sessionId: string, message: ChatMessage): string {
  const db = getDb();
  const messageId = id('msg');
  const at = message.at ?? now();
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, tool_calls, tool_results, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    messageId,
    sessionId,
    message.role,
    message.content,
    message.toolCalls ? JSON.stringify(message.toolCalls) : null,
    message.toolResults ? JSON.stringify(message.toolResults) : null,
    at,
  );
  if (hasFts() && message.content && (message.role === 'user' || message.role === 'assistant')) {
    db.prepare(`INSERT INTO messages_fts (content, session_id, message_id) VALUES (?, ?, ?)`).run(
      message.content,
      sessionId,
      messageId,
    );
  }
  touchSession(sessionId);
  return messageId;
}

interface MessageRow {
  role: string;
  content: string;
  tool_calls: string | null;
  tool_results: string | null;
  at: number;
}

export function getMessages(sessionId: string, limit = 200): ChatMessage[] {
  const rows = getDb()
    .prepare(
      `SELECT role, content, tool_calls, tool_results, at FROM messages
       WHERE session_id = ? ORDER BY at ASC, rowid ASC LIMIT ?`,
    )
    .all(sessionId, limit) as unknown as MessageRow[];
  return rows.map((r) => ({
    role: r.role as ChatMessage['role'],
    content: r.content,
    toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
    toolResults: r.tool_results ? JSON.parse(r.tool_results) : undefined,
    at: r.at,
  }));
}

export interface SearchHit {
  sessionId: string;
  messageId: string;
  snippet: string;
}

/** Full-text search across sessions (optionally scoped to a project). */
export function searchMessages(
  query: string,
  projectSlug: string | null | undefined,
  limit = 12,
): SearchHit[] {
  const db = getDb();
  if (hasFts()) {
    // FTS5 query syntax can throw on special chars — quote each term.
    const safe = query
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => `"${t.replaceAll('"', '')}"`)
      .join(' ');
    if (!safe) return [];
    const rows = db
      .prepare(
        `SELECT f.session_id AS sessionId, f.message_id AS messageId,
                snippet(messages_fts, 0, '<<', '>>', '…', 12) AS snippet
         FROM messages_fts f
         JOIN sessions s ON s.id = f.session_id
         WHERE messages_fts MATCH ? ${projectSlug !== undefined ? 'AND s.project_slug IS ?' : ''}
         LIMIT ?`,
      )
      .all(...(projectSlug !== undefined ? [safe, projectSlug, limit] : [safe, limit])) as unknown as SearchHit[];
    return rows;
  }
  const rows = db
    .prepare(
      `SELECT m.session_id AS sessionId, m.id AS messageId, substr(m.content, 1, 160) AS snippet
       FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.content LIKE ? ${projectSlug !== undefined ? 'AND s.project_slug IS ?' : ''}
       ORDER BY m.at DESC LIMIT ?`,
    )
    .all(
      ...(projectSlug !== undefined
        ? [`%${query}%`, projectSlug, limit]
        : [`%${query}%`, limit]),
    ) as unknown as SearchHit[];
  return rows;
}

export function listUnsummarizedIdleSessions(idleMs: number, limit = 10): Session[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE summarized = 0 AND last_active_at < ?
         AND (SELECT COUNT(*) FROM messages WHERE session_id = sessions.id) >= 2
       ORDER BY last_active_at ASC LIMIT ?`,
    )
    .all(now() - idleMs, limit) as unknown as SessionRow[];
  return rows.map(rowToSession);
}

export function markSummarized(sessionId: string): void {
  getDb().prepare(`UPDATE sessions SET summarized = 1 WHERE id = ?`).run(sessionId);
}
