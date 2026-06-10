import { DatabaseSync } from 'node:sqlite';
import { paths, ensureHome } from '../../shared/paths.ts';
import { log } from '../../shared/util.ts';

const SCHEMA_VERSION = 1;

let db: DatabaseSync | null = null;
let ftsAvailable = false;

export function getDb(): DatabaseSync {
  if (db) return db;
  ensureHome();
  db = new DatabaseSync(paths.db());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function hasFts(): boolean {
  getDb();
  return ftsAvailable;
}

/** For tests: close and reset the singleton. */
export function closeDb(): void {
  db?.close();
  db = null;
  ftsAvailable = false;
}

function migrate(d: DatabaseSync): void {
  d.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = d
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;

  if (current < 1) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_slug TEXT,
        channel_origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        title TEXT,
        parent_session_id TEXT,
        summarized INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_slug, last_active_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_results TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, at);

      CREATE TABLE IF NOT EXISTS bindings (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        project_slug TEXT,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id)
      );

      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT,
        project_slug TEXT,
        detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);

      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        schedule TEXT NOT NULL,
        prompt TEXT NOT NULL,
        project_slug TEXT,
        delivery TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS plugin_state (
        plugin TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (plugin, key)
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL,        -- 'magic-link' | 'session'
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    d.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
      String(SCHEMA_VERSION),
    );
  }

  // FTS5 is bundled with Node's SQLite, but degrade gracefully if absent.
  try {
    d.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, session_id UNINDEXED, message_id UNINDEXED
      )
    `);
    ftsAvailable = true;
  } catch {
    ftsAvailable = false;
    log('db', 'FTS5 unavailable — falling back to LIKE search');
  }
}
