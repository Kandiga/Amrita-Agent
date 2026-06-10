import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@amrita/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentVersion, migrateDown, migrateUp } from '../src/migrate.ts';
import { type Store, openStore } from '../src/store.ts';

let tmp: string;
let store: Store;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'amrita-store-'));
  store = openStore({ path: ':memory:', spillDir: join(tmp, 'artifacts') });
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

function project(): string {
  return store.createProject({ slug: `p-${newId().toLowerCase().slice(0, 8)}`, name: 'Test' }).id;
}

const REQUIRED_TABLES = [
  'projects',
  'conversations',
  'messages',
  'messages_fts',
  'events',
  'artifacts',
  'schema_migrations',
  'tasks',
  'decisions',
  'memory_entries',
  'lanes',
  'accounts',
  'connectors',
  'settings',
];

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
}

describe('migrations', () => {
  it('apply up, down, and up again (reversible) across both migrations', () => {
    const db = new Database(':memory:');
    expect(currentVersion(db)).toBe(-1);

    // up: both 0000 and 0001 apply
    expect(migrateUp(db)).toBe(2);
    expect(currentVersion(db)).toBe(1);
    for (const name of REQUIRED_TABLES) {
      expect(tableNames(db)).toContain(name);
    }

    // full down: both revert; even the lineage column is gone
    expect(migrateDown(db)).toBe(2);
    expect(currentVersion(db)).toBe(-1);
    expect(tableNames(db)).not.toContain('events');
    expect(tableNames(db)).not.toContain('tasks');

    // up again — and a second up is a no-op
    expect(migrateUp(db)).toBe(2);
    expect(currentVersion(db)).toBe(1);
    expect(migrateUp(db)).toBe(0);
    db.close();
  });

  it('targets a single migration with toVersion (down to 0 reverts only 0001)', () => {
    const db = new Database(':memory:');
    migrateUp(db);
    // revert everything above version 0 → only 0001
    expect(migrateDown(db, 0)).toBe(1);
    expect(currentVersion(db)).toBe(0);
    expect(tableNames(db)).toContain('events'); // spine intact
    expect(tableNames(db)).not.toContain('tasks'); // 0001 reverted
    // parent_id column is gone again
    const cols = (db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('parent_id');
    db.close();
  });

  it('all required tables exist after openStore migration', () => {
    for (const name of REQUIRED_TABLES) {
      expect(tableNames(store.db)).toContain(name);
    }
  });
});

describe('seq assignment', () => {
  it('is monotonic and independent per conversation', () => {
    const projectId = project();
    const a = store.createConversation({ projectId }).id;
    const b = store.createConversation({ projectId }).id;

    const e1 = store.appendEvent(unsealed(projectId, a, 'message.agent', { text: 'a1' }));
    const e2 = store.appendEvent(unsealed(projectId, a, 'message.agent', { text: 'a2' }));
    const e3 = store.appendEvent(unsealed(projectId, b, 'message.agent', { text: 'b1' }));

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(1); // b's own counter

    const eventsA = store.getEvents(a);
    expect(eventsA.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.getEvents(a, 1).map((e) => e.seq)).toEqual([2]);
  });
});

describe('hybrid user message', () => {
  it('writes a message row and a message.user event in one transaction', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    const { message, event } = store.recordUserMessage({
      projectId,
      conversationId: c,
      text: 'fix the PDF export bug',
      channel: 'web',
    });
    expect(message.role).toBe('user');
    expect(event.type).toBe('message.user');
    expect(event.seq).toBe(1);

    const rows = store.db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?')
      .get(c) as { n: number };
    expect(rows.n).toBe(1);
    expect(store.getEvents(c)).toHaveLength(1);
  });
});

describe('full-text search', () => {
  it('returns ranked hits with a snippet', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    store.recordUserMessage({
      projectId,
      conversationId: c,
      text: 'the quote template breaks on RTL text',
    });
    store.recordUserMessage({
      projectId,
      conversationId: c,
      text: 'export pipeline performance notes',
    });
    store.recordUserMessage({
      projectId,
      conversationId: c,
      text: 'RTL RTL RTL handling in the renderer',
    });

    const hits = store.searchMessages('RTL');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // bm25: lower rank == better; results are ordered best-first
    expect(hits[0]?.rank).toBeLessThanOrEqual(hits[1]?.rank ?? Number.POSITIVE_INFINITY);
    expect(hits[0]?.snippet).toContain('[');
    expect(hits.every((h) => h.text.includes('RTL'))).toBe(true);

    const scoped = store.searchMessages('export', { conversationId: c });
    expect(scoped).toHaveLength(1);
  });
});

describe('tool payload spill', () => {
  it('spills a >32KB tool result to an artifact and rewrites the payload', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    const big = 'x'.repeat(40_000);
    const ev = store.appendEvent(
      unsealed(projectId, c, 'tool.completed', {
        toolCallId: 'tc-1',
        result: { result: big, isError: false },
      }),
    );
    expect(ev.type).toBe('tool.completed');
    if (ev.type === 'tool.completed') {
      expect(ev.payload.result.spilledArtifactId).toBeTypeOf('string');
      expect(ev.payload.result.result).toBeUndefined();
      expect(ev.payload.result.preview?.length).toBeLessThanOrEqual(500);
      const artifactId = ev.payload.result.spilledArtifactId as string;
      const row = store.db
        .prepare('SELECT path, bytes FROM artifacts WHERE id = ?')
        .get(artifactId) as { path: string; bytes: number };
      expect(existsSync(row.path)).toBe(true);
      expect(JSON.parse(readFileSync(row.path, 'utf8'))).toBe(big);
    }
  });

  it('keeps a small tool result inline', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    const ev = store.appendEvent(
      unsealed(projectId, c, 'tool.completed', {
        toolCallId: 'tc-2',
        result: { result: { ok: true }, isError: false },
      }),
    );
    if (ev.type === 'tool.completed') {
      expect(ev.payload.result.result).toEqual({ ok: true });
      expect(ev.payload.result.spilledArtifactId).toBeUndefined();
    }
    const artifacts = store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as {
      n: number;
    };
    expect(artifacts.n).toBe(0);
  });
});

describe('stream-only events', () => {
  it('refuses to persist model.delta', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    expect(() =>
      store.appendEvent(unsealed(projectId, c, 'model.delta', { text: 'partial' })),
    ).toThrow(/stream-only/);
    expect(store.getEvents(c)).toHaveLength(0);
  });
});

describe('conversation lineage (parent_id)', () => {
  it('represents a parent → child relationship', () => {
    const projectId = project();
    const parent = store.createConversation({ projectId }).id;
    const childId = newId();
    const ts = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO conversations (id, project_id, title, created_at, updated_at, parent_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(childId, projectId, 'branch', ts, ts, parent);
    const row = store.db
      .prepare('SELECT parent_id AS parentId FROM conversations WHERE id = ?')
      .get(childId) as { parentId: string };
    expect(row.parentId).toBe(parent);
  });

  it('rejects a self-parent and a missing parent', () => {
    const projectId = project();
    const ts = new Date().toISOString();
    const id = newId();
    const insert = (parentId: string) =>
      store.db
        .prepare(
          `INSERT INTO conversations (id, project_id, title, created_at, updated_at, parent_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, projectId, null, ts, ts, parentId);
    expect(() => insert(id)).toThrow(/its own parent/);
    expect(() => insert(newId())).toThrow(/parent conversation does not exist/);
  });
});

describe('decisions are append-only', () => {
  function insertDecision(projectId: string, text: string, supersedes?: string): string {
    const id = newId();
    const ts = new Date().toISOString();
    store.db
      .prepare(
        `INSERT INTO decisions (id, project_id, text, supersedes_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, text, supersedes ?? null, ts);
    return id;
  }

  it('allows insert + supersede but blocks update and delete', () => {
    const projectId = project();
    const first = insertDecision(projectId, 'use SQLite');
    // supersede with a new row — allowed
    const second = insertDecision(projectId, 'use SQLite + WAL', first);
    expect(second).toBeTypeOf('string');

    expect(() =>
      store.db.prepare('UPDATE decisions SET text = ? WHERE id = ?').run('changed', first),
    ).toThrow(/append-only/);
    expect(() => store.db.prepare('DELETE FROM decisions WHERE id = ?').run(first)).toThrow(
      /append-only/,
    );
  });
});

describe('no secrets in accounts/settings (schema tripwires)', () => {
  const ts = () => new Date().toISOString();

  function insertAccount(secretRef: string | null): void {
    store.db
      .prepare(
        `INSERT INTO accounts (id, provider, label, auth_mode, secret_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), 'anthropic', secretRef ?? null, 'api_key', secretRef, ts(), ts());
  }

  it('accepts an ENV-NAME secret_ref but rejects non-env-name values', () => {
    expect(() => insertAccount('ANTHROPIC_API_KEY')).not.toThrow();
    // lowercase + dashes is not an ENV-NAME → rejected by the schema CHECK
    expect(() => insertAccount('not-an-env-name')).toThrow();
    expect(() => insertAccount('lowercase_name')).toThrow();
  });

  it('stores only a secret_ref, never a value (sanity on the persisted column)', () => {
    insertAccount('OPENAI_API_KEY');
    const row = store.db
      .prepare("SELECT secret_ref AS r FROM accounts WHERE secret_ref = 'OPENAI_API_KEY'")
      .get() as { r: string };
    expect(row.r).toBe('OPENAI_API_KEY');
    expect(row.r).not.toMatch(/^sk-/);
  });

  it('rejects secret-ish settings keys, accepts plain config', () => {
    const put = (key: string) =>
      store.db
        .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
        .run(key, '"v"', ts());
    expect(() => put('theme')).not.toThrow();
    expect(() => put('openai_api_key')).toThrow();
    expect(() => put('telegram_bot_token')).toThrow();
  });
});

describe('memory_entries scope + budget', () => {
  const ts = () => new Date().toISOString();
  function insertMemory(scope: string, projectId: string | null, content: string): void {
    store.db
      .prepare(
        `INSERT INTO memory_entries (id, scope, project_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), scope, projectId, content, ts(), ts());
  }

  it('enforces scope/project_id consistency and the char budget; computes char_count', () => {
    const projectId = project();
    insertMemory('project', projectId, 'remember the brief');
    insertMemory('user', null, 'global preference');

    const row = store.db
      .prepare("SELECT char_count AS n FROM memory_entries WHERE content = 'global preference'")
      .get() as { n: number };
    expect(row.n).toBe('global preference'.length);

    expect(() => insertMemory('project', null, 'x')).toThrow(); // project scope needs a project
    expect(() => insertMemory('user', projectId, 'x')).toThrow(); // user scope must not have one
    expect(() => insertMemory('project', projectId, 'y'.repeat(4001))).toThrow(); // over budget
  });
});

describe('lanes persistence', () => {
  it('stores a lane with mandate/budget/merge JSON and a checked status', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    const ts = new Date().toISOString();
    const laneId = newId();
    store.db
      .prepare(
        `INSERT INTO lanes (id, project_id, conversation_id, kind, status, mandate_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(laneId, projectId, c, 'claude-code', 'spawned', '{"goal":"x"}', ts, ts);
    const row = store.db.prepare('SELECT status FROM lanes WHERE id = ?').get(laneId) as {
      status: string;
    };
    expect(row.status).toBe('spawned');
    expect(() =>
      store.db.prepare('UPDATE lanes SET status = ? WHERE id = ?').run('not-a-status', laneId),
    ).toThrow();
  });
});

// ── helper ──────────────────────────────────────────────────────────────────
function unsealed(
  projectId: string,
  conversationId: string,
  type: string,
  payload: unknown,
): Parameters<Store['appendEvent']>[0] {
  return {
    id: newId(),
    ts: new Date().toISOString(),
    projectId,
    conversationId,
    origin: 'agent',
    type,
    payload,
  } as Parameters<Store['appendEvent']>[0];
}
