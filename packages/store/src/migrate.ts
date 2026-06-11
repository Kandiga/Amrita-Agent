import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

type DB = Database.Database;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

function load(version: number, name: string): Migration {
  const base = `${String(version).padStart(4, '0')}_${name}`;
  return {
    version,
    name,
    up: readFileSync(join(migrationsDir, `${base}.sql`), 'utf8'),
    down: readFileSync(join(migrationsDir, `${base}.down.sql`), 'utf8'),
  };
}

/** Ordered list of migrations. Append-only — never edit a shipped migration. */
export const MIGRATIONS: readonly Migration[] = [
  load(0, 'init'),
  load(1, 'full_store_schema'),
  load(2, 'memory_fts'),
  load(3, 'channel_pairings'),
  load(4, 'companion'),
];

function ensureMigrationsTable(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
}

function appliedVersions(db: DB): Set<number> {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map((r) => r.version));
}

/** Apply every migration not yet recorded, in order. Idempotent. */
export function migrateUp(db: DB): number {
  const applied = appliedVersions(db);
  let count = 0;
  const stamp = new Date().toISOString();
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        m.version,
        stamp,
      );
      db.exec('COMMIT');
      count++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return count;
}

/** Revert the most recently applied migration (or down to `toVersion` exclusive). */
export function migrateDown(db: DB, toVersion = -1): number {
  const applied = appliedVersions(db);
  let count = 0;
  // revert highest-first
  for (const m of [...MIGRATIONS].reverse()) {
    if (!applied.has(m.version) || m.version <= toVersion) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.down);
      db.prepare('DELETE FROM schema_migrations WHERE version = ?').run(m.version);
      db.exec('COMMIT');
      count++;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return count;
}

/** The current schema version (highest applied), or -1 if none. */
export function currentVersion(db: DB): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? -1;
}
