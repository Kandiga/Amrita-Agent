import type { AmritaEvent } from '@amrita/protocol';
import type Database from 'better-sqlite3';

type DB = Database.Database;
type Bind = string | number | null;

/**
 * Same-transaction event → read-model projection (the reducer).
 *
 * Contract (see ADR-0006):
 * - MUST be called from inside an open SQLite transaction; the store calls it
 *   from `appendEvent`, after the event row is inserted, on the same `db`.
 * - Pure except for SQLite writes on `db`. No filesystem, no network, no clock:
 *   every timestamp comes from `ev.ts`, so projecting the same event twice is
 *   deterministic.
 * - If any write violates a constraint (FK / CHECK / append-only trigger) it
 *   throws, and the surrounding transaction — including the event insert — rolls
 *   back atomically.
 * - Never writes a secret: provider events touch only health metadata; settings
 *   and accounts keep their secret tripwires from ADR-0003.
 *
 * Events with no read-model are a no-op here (they still live in the event log).
 */
export function applyEventProjection(db: DB, ev: AmritaEvent): void {
  switch (ev.type) {
    // ── transcript: every message.* materializes one row (id == event id) ──
    case 'message.user':
    case 'message.agent':
    case 'message.system': {
      const role =
        ev.type === 'message.user' ? 'user' : ev.type === 'message.agent' ? 'agent' : 'system';
      db.prepare(
        `INSERT INTO messages (id, conversation_id, turn_id, role, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(ev.id, ev.conversationId, ev.turnId ?? null, role, JSON.stringify(ev.payload), ev.ts);
      return;
    }

    // ── tasks ────────────────────────────────────────────────────────────
    case 'task.created': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO tasks
           (id, project_id, conversation_id, source_message_id, lane_id, status, title, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.taskId,
        p.projectId,
        p.conversationId ?? null,
        p.sourceMessageId ?? null,
        p.laneId ?? null,
        p.status ?? 'now',
        p.title,
        null,
        ev.ts,
        ev.ts,
      );
      return;
    }
    case 'task.updated': {
      const p = ev.payload;
      const sets: string[] = [];
      const vals: Bind[] = [];
      if (p.status !== undefined) {
        sets.push('status = ?');
        vals.push(p.status);
      }
      if (p.title !== undefined) {
        sets.push('title = ?');
        vals.push(p.title);
      }
      if (p.body !== undefined) {
        sets.push('body = ?');
        vals.push(p.body);
      }
      sets.push('updated_at = ?');
      vals.push(ev.ts, p.taskId);
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return;
    }
    case 'task.completed': {
      db.prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?").run(
        ev.ts,
        ev.payload.taskId,
      );
      return;
    }

    // ── decisions (append-only: INSERT only, never UPDATE/DELETE) ──────────
    case 'decision.recorded': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO decisions (id, project_id, conversation_id, source_message_id, supersedes_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.decisionId,
        p.projectId,
        p.conversationId ?? null,
        p.sourceMessageId ?? null,
        null,
        p.text,
        ev.ts,
      );
      return;
    }
    case 'decision.superseded': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO decisions (id, project_id, conversation_id, source_message_id, supersedes_id, text, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.decisionId,
        p.projectId,
        p.conversationId ?? null,
        p.sourceMessageId ?? null,
        p.supersedesId,
        p.text,
        ev.ts,
      );
      return;
    }

    // ── memory_entries (metadata projection; content never comes from events) ─
    case 'memory.updated': {
      const p = ev.payload;
      // scope + project_id are written together to keep the schema's
      // scope/project_id CHECK consistent; an inconsistent event rolls back.
      // No-op if the row doesn't exist yet (content-bearing creation is a direct
      // store concern, not an event — see ADR-0006).
      db.prepare(
        `UPDATE memory_entries
            SET scope = ?, project_id = ?,
                source = COALESCE(?, source),
                source_message_id = COALESCE(?, source_message_id),
                updated_at = ?
          WHERE id = ?`,
      ).run(
        p.scope,
        p.projectId ?? null,
        p.source ?? null,
        p.sourceMessageId ?? null,
        ev.ts,
        p.entryId,
      );
      return;
    }
    case 'memory.consolidated': {
      const p = ev.payload;
      // Mark the result entry consolidated; source rows are left intact (no
      // destructive GC in the reducer — deferred). No-op if result is absent.
      db.prepare(
        "UPDATE memory_entries SET scope = ?, project_id = ?, source = 'consolidated', updated_at = ? WHERE id = ?",
      ).run(p.scope, p.projectId ?? null, ev.ts, p.resultEntryId);
      return;
    }

    // ── provider account health (metadata_json only, never secret_ref) ────
    case 'provider.connected':
    case 'provider.degraded':
    case 'provider.restored': {
      const p = ev.payload;
      if (!p.accountId) return; // health with no account to attach to: log-only
      const row = db.prepare('SELECT metadata_json FROM accounts WHERE id = ?').get(p.accountId) as
        | { metadata_json: string | null }
        | undefined;
      if (!row) return;
      const meta = (row.metadata_json ? JSON.parse(row.metadata_json) : {}) as Record<
        string,
        unknown
      >;
      meta.health =
        ev.type === 'provider.connected'
          ? 'connected'
          : ev.type === 'provider.degraded'
            ? 'degraded'
            : 'restored';
      meta.healthAt = ev.ts;
      if (ev.type === 'provider.degraded') meta.healthReason = ev.payload.reason;
      else meta.healthReason = undefined;
      db.prepare('UPDATE accounts SET metadata_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(meta),
        ev.ts,
        p.accountId,
      );
      return;
    }

    // ── connectors ─────────────────────────────────────────────────────────
    case 'connector.installed': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO connectors (id, slug, kind, status, manifest_json, config_json, created_at, updated_at)
         VALUES (?, ?, ?, 'needs_setup', NULL, NULL, ?, ?)`,
      ).run(p.connectorId, p.slug, p.kind, ev.ts, ev.ts);
      return;
    }
    case 'connector.updated': {
      const p = ev.payload;
      const sets: string[] = [];
      const vals: Bind[] = [];
      if (p.status !== undefined) {
        sets.push('status = ?');
        vals.push(p.status);
      }
      // `fields` is provenance (which keys changed); actual config values are not
      // carried on the event (no secrets on the wire), so they are not applied.
      sets.push('updated_at = ?');
      vals.push(ev.ts, p.connectorId);
      db.prepare(`UPDATE connectors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return;
    }
    case 'connector.removed': {
      db.prepare('DELETE FROM connectors WHERE id = ?').run(ev.payload.connectorId);
      return;
    }

    // ── settings (secret-ish keys already blocked by the event schema + CHECK) ─
    case 'settings.updated': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      ).run(p.key, JSON.stringify(p.value ?? null), ev.ts);
      return;
    }

    // ── lanes (state machine; project/conversation from the envelope) ──────
    case 'lane.spawned': {
      const p = ev.payload;
      db.prepare(
        `INSERT INTO lanes (id, project_id, conversation_id, kind, status, mandate_json, budget_json, merge_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'spawned', '{}', NULL, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      ).run(p.laneId, ev.projectId, ev.conversationId, p.kind, ev.ts, ev.ts);
      return;
    }
    case 'lane.mandate': {
      const m = ev.payload;
      db.prepare(
        'UPDATE lanes SET mandate_json = ?, budget_json = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify(m), m.budget ? JSON.stringify(m.budget) : null, ev.ts, m.laneId);
      return;
    }
    case 'lane.progress': {
      if (!ev.laneId) return; // progress payload carries no laneId; use the envelope
      db.prepare(
        "UPDATE lanes SET status = 'running', updated_at = ? WHERE id = ? AND status = 'spawned'",
      ).run(ev.ts, ev.laneId);
      return;
    }
    case 'lane.merge_report': {
      const r = ev.payload;
      db.prepare(
        "UPDATE lanes SET merge_json = ?, status = 'merging', updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(r), ev.ts, r.laneId);
      return;
    }
    case 'lane.completed': {
      db.prepare("UPDATE lanes SET status = 'completed', updated_at = ? WHERE id = ?").run(
        ev.ts,
        ev.payload.laneId,
      );
      return;
    }
    case 'lane.aborted': {
      db.prepare("UPDATE lanes SET status = 'aborted', updated_at = ? WHERE id = ?").run(
        ev.ts,
        ev.payload.laneId,
      );
      return;
    }

    default:
      // Log-only event: persisted in `events`, no read-model projection.
      return;
  }
}
