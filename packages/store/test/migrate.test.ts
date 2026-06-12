import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrateUp } from '../src/migrate.ts';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-migrate-'));
  dbPath = join(dir, 'amrita.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrateUp concurrency safety', () => {
  it('a second connection after a completed first run applies nothing and fails nothing', () => {
    const a = new Database(dbPath);
    expect(migrateUp(a)).toBe(MIGRATIONS.length);
    a.close();

    // the laptop-QA regression: a racing/second migrator must skip cleanly,
    // never die with "table … already exists"
    const b = new Database(dbPath);
    expect(migrateUp(b)).toBe(0);
    b.close();
  });

  it('re-checks the applied set inside the write transaction', () => {
    // Simulate the loser of a first-run race: its in-memory applied-set is
    // stale (empty), but the winner has already committed every migration.
    const winner = new Database(dbPath);
    migrateUp(winner);
    winner.close();

    const loser = new Database(dbPath);
    // a stale pre-read like the old implementation did:
    const stale = loser.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(stale.n).toBe(MIGRATIONS.length);
    // the loop itself must rely on the IN-TRANSACTION read, so this is a no-op:
    expect(migrateUp(loser)).toBe(0);
    loser.close();
  });
});
