import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@amrita/protocol';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, currentVersion, migrateDown, migrateUp } from '../src/migrate.ts';
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
  'memory_entries_fts',
  'lanes',
  'accounts',
  'connectors',
  'settings',
  'channel_pairings',
  'project_briefs',
  'open_questions',
  'risks',
  'milestones',
  'project_brands',
  'preview_approvals',
  'inbox_items',
  'phases',
  'project_publications',
];

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
}

// Derived, not hard-coded: a new migration must not break the reversibility test.
const MIGRATION_COUNT = MIGRATIONS.length;
const TOP_VERSION = MIGRATION_COUNT - 1;

describe('migrations', () => {
  it('apply up, down, and up again (reversible) across all migrations', () => {
    const db = new Database(':memory:');
    expect(currentVersion(db)).toBe(-1);

    // up: every migration applies
    expect(migrateUp(db)).toBe(MIGRATION_COUNT);
    expect(currentVersion(db)).toBe(TOP_VERSION);
    for (const name of REQUIRED_TABLES) {
      expect(tableNames(db)).toContain(name);
    }

    // full down: all revert; even the lineage + milestone columns are gone
    expect(migrateDown(db)).toBe(MIGRATION_COUNT);
    expect(currentVersion(db)).toBe(-1);
    expect(tableNames(db)).not.toContain('events');
    expect(tableNames(db)).not.toContain('tasks');
    expect(tableNames(db)).not.toContain('memory_entries_fts');
    expect(tableNames(db)).not.toContain('channel_pairings');
    expect(tableNames(db)).not.toContain('project_briefs');
    expect(tableNames(db)).not.toContain('milestones');
    expect(tableNames(db)).not.toContain('project_brands');

    // up again — and a second up is a no-op
    expect(migrateUp(db)).toBe(MIGRATION_COUNT);
    expect(currentVersion(db)).toBe(TOP_VERSION);
    expect(migrateUp(db)).toBe(0);
    db.close();
  });

  it('migration 0018 reversibly adds lane idempotency and correlation metadata', () => {
    const db = new Database(':memory:');
    migrateUp(db);

    const columns = () =>
      (db.prepare('PRAGMA table_info(lanes)').all() as { name: string }[]).map((row) => row.name);
    const indexes = () =>
      (db.prepare('PRAGMA index_list(lanes)').all() as { name: string }[]).map((row) => row.name);
    const addedColumns = ['idempotency_key', 'group_id', 'role', 'verifies_lane_id'];
    const addedIndexes = ['idx_lanes_idempotency', 'idx_lanes_group', 'idx_lanes_verifies_lane'];

    expect(currentVersion(db)).toBe(TOP_VERSION);
    for (const name of addedColumns) expect(columns()).toContain(name);
    for (const name of addedIndexes) expect(indexes()).toContain(name);

    expect(migrateDown(db, 17)).toBe(TOP_VERSION - 17);
    for (const name of addedColumns) expect(columns()).not.toContain(name);
    for (const name of addedIndexes) expect(indexes()).not.toContain(name);

    expect(migrateUp(db)).toBe(TOP_VERSION - 17);
    for (const name of addedColumns) expect(columns()).toContain(name);
    for (const name of addedIndexes) expect(indexes()).toContain(name);
    db.close();
  });

  it('migration 0019 reversibly adds acceptance evidence to tasks (ADR-0055)', () => {
    const db = new Database(':memory:');
    migrateUp(db);
    const cols = () =>
      (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((row) => row.name);
    const added = ['acceptance_json', 'verified_at', 'verification_json'];
    for (const name of added) expect(cols()).toContain(name);
    expect(migrateDown(db, 18)).toBe(1);
    for (const name of added) expect(cols()).not.toContain(name);
    expect(migrateUp(db)).toBe(1);
    for (const name of added) expect(cols()).toContain(name);
    db.close();
  });

  it('targets migrations with toVersion (step down from the top)', () => {
    const db = new Database(':memory:');
    migrateUp(db);
    // revert everything above version 1 (FTS, pairings, companion, brand,
    // external ref, whatsapp, cascade, project-ts index, …)
    expect(migrateDown(db, 1)).toBe(TOP_VERSION - 1);
    expect(currentVersion(db)).toBe(1);
    expect(tableNames(db)).not.toContain('memory_entries_fts');
    expect(tableNames(db)).not.toContain('channel_pairings');
    expect(tableNames(db)).not.toContain('open_questions');
    expect(tableNames(db)).toContain('memory_entries'); // 0001 intact
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(taskCols).not.toContain('milestone_id'); // 0004's column reverted

    // revert above version 0 → just 0001
    expect(migrateDown(db, 0)).toBe(1);
    expect(currentVersion(db)).toBe(0);
    expect(tableNames(db)).toContain('events'); // spine intact
    expect(tableNames(db)).not.toContain('tasks'); // 0001 reverted
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

describe('event projection (WO#1.3)', () => {
  function setup(): { projectId: string; conversationId: string } {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    return { projectId, conversationId };
  }
  function evt(
    projectId: string,
    conversationId: string,
    type: string,
    payload: unknown,
    over: Record<string, unknown> = {},
  ): Parameters<Store['appendEvent']>[0] {
    return {
      id: newId(),
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      origin: 'agent',
      type,
      payload,
      ...over,
    } as Parameters<Store['appendEvent']>[0];
  }

  it('rolls back the event when projection fails (atomicity)', () => {
    const { projectId, conversationId } = setup();
    const before = store.getEvents(conversationId).length;
    // tasks.project_id FK → a non-existent project violates the FK inside the tx
    expect(() =>
      store.appendEvent(
        evt(projectId, conversationId, 'task.created', {
          taskId: newId(),
          projectId: newId(),
          title: 'orphan',
        }),
      ),
    ).toThrow();
    expect(store.getEvents(conversationId).length).toBe(before); // event not persisted
    const taskCount = store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(taskCount.n).toBe(0);
  });

  it('projects task.created / task.updated / task.completed', () => {
    const { projectId, conversationId } = setup();
    const taskId = newId();
    store.appendEvent(
      evt(projectId, conversationId, 'task.created', {
        taskId,
        projectId,
        conversationId,
        title: 'fix bug',
        status: 'now',
      }),
    );
    let row = store.db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(taskId) as {
      status: string;
      title: string;
    };
    expect(row.status).toBe('now');
    expect(row.title).toBe('fix bug');

    store.appendEvent(
      evt(projectId, conversationId, 'task.updated', {
        taskId,
        status: 'later',
        title: 'fix the PDF bug',
      }),
    );
    row = store.db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(taskId) as {
      status: string;
      title: string;
    };
    expect(row.status).toBe('later');
    expect(row.title).toBe('fix the PDF bug');

    store.appendEvent(evt(projectId, conversationId, 'task.completed', { taskId }));
    row = store.db.prepare('SELECT status, title FROM tasks WHERE id = ?').get(taskId) as {
      status: string;
      title: string;
    };
    expect(row.status).toBe('done');
  });

  it('projects decisions append-only (recorded + superseded); triggers still hold', () => {
    const { projectId, conversationId } = setup();
    const first = newId();
    store.appendEvent(
      evt(projectId, conversationId, 'decision.recorded', {
        decisionId: first,
        projectId,
        text: 'use SQLite',
      }),
    );
    const second = newId();
    store.appendEvent(
      evt(projectId, conversationId, 'decision.superseded', {
        decisionId: second,
        supersedesId: first,
        projectId,
        text: 'use SQLite + WAL',
      }),
    );
    const rows = store.db
      .prepare('SELECT id, supersedes_id AS s FROM decisions ORDER BY created_at')
      .all() as { id: string; s: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === second)?.s).toBe(first);
    // append-only invariant still enforced after projection
    expect(() =>
      store.db.prepare('UPDATE decisions SET text = ? WHERE id = ?').run('x', first),
    ).toThrow(/append-only/);
    expect(() => store.db.prepare('DELETE FROM decisions WHERE id = ?').run(first)).toThrow(
      /append-only/,
    );
  });

  it('upserts memory_entries from memory.updated/consolidated content (ADR-0007)', () => {
    const { projectId, conversationId } = setup();
    const entryId = newId();
    // create via event (no pre-existing row needed any more)
    store.appendEvent(
      evt(projectId, conversationId, 'memory.updated', {
        entryId,
        scope: 'project',
        content: 'remember the brief',
        projectId,
        source: 'curated',
      }),
    );
    let row = store.db
      .prepare('SELECT content, source, char_count AS cc FROM memory_entries WHERE id = ?')
      .get(entryId) as { content: string; source: string; cc: number };
    expect(row.content).toBe('remember the brief');
    expect(row.source).toBe('curated');
    expect(row.cc).toBe('remember the brief'.length); // char_count generated from content

    // update content via the same event type
    store.appendEvent(
      evt(projectId, conversationId, 'memory.updated', {
        entryId,
        scope: 'project',
        content: 'remember the RTL brief',
        projectId,
      }),
    );
    row = store.db
      .prepare('SELECT content, source, char_count AS cc FROM memory_entries WHERE id = ?')
      .get(entryId) as { content: string; source: string; cc: number };
    expect(row.content).toBe('remember the RTL brief');
    expect(row.cc).toBe('remember the RTL brief'.length);
    expect(row.source).toBe('curated'); // COALESCE preserves source when omitted

    const resultId = newId();
    store.appendEvent(
      evt(projectId, conversationId, 'memory.consolidated', {
        resultEntryId: resultId,
        sourceEntryIds: [entryId],
        content: 'merged note',
        scope: 'project',
        projectId,
      }),
    );
    row = store.db
      .prepare('SELECT content, source, char_count AS cc FROM memory_entries WHERE id = ?')
      .get(resultId) as { content: string; source: string; cc: number };
    expect(row.content).toBe('merged note');
    expect(row.source).toBe('consolidated');
  });

  it('projects provider health into metadata_json without touching secret_ref', () => {
    const { projectId, conversationId } = setup();
    const ts = new Date().toISOString();
    const accountId = newId();
    store.db
      .prepare(
        'INSERT INTO accounts (id, provider, label, auth_mode, secret_ref, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(accountId, 'anthropic', 'work', 'api_key', 'ANTHROPIC_API_KEY', ts, ts);

    store.appendEvent(
      evt(projectId, conversationId, 'provider.degraded', {
        provider: 'anthropic',
        accountId,
        reason: 'credit exhausted',
      }),
    );
    let row = store.db
      .prepare('SELECT secret_ref AS s, metadata_json AS m FROM accounts WHERE id = ?')
      .get(accountId) as { s: string; m: string };
    expect(row.s).toBe('ANTHROPIC_API_KEY'); // secret_ref never touched
    expect(JSON.parse(row.m).health).toBe('degraded');
    expect(JSON.parse(row.m).healthReason).toBe('credit exhausted');

    store.appendEvent(
      evt(projectId, conversationId, 'provider.restored', { provider: 'anthropic', accountId }),
    );
    row = store.db
      .prepare('SELECT secret_ref AS s, metadata_json AS m FROM accounts WHERE id = ?')
      .get(accountId) as { s: string; m: string };
    expect(JSON.parse(row.m).health).toBe('restored');
    expect(JSON.parse(row.m).healthReason ?? null).toBeNull();
    expect(row.s).toBe('ANTHROPIC_API_KEY');
  });

  it('projects connector install / update / remove', () => {
    const { projectId, conversationId } = setup();
    const connectorId = newId();
    store.appendEvent(
      evt(projectId, conversationId, 'connector.installed', {
        connectorId,
        slug: 'claude-code',
        kind: 'cli',
      }),
    );
    let row = store.db.prepare('SELECT status FROM connectors WHERE id = ?').get(connectorId) as {
      status: string;
    };
    expect(row.status).toBe('needs_setup');

    store.appendEvent(
      evt(projectId, conversationId, 'connector.updated', {
        connectorId,
        slug: 'claude-code',
        status: 'ready',
        fields: ['status'],
      }),
    );
    row = store.db.prepare('SELECT status FROM connectors WHERE id = ?').get(connectorId) as {
      status: string;
    };
    expect(row.status).toBe('ready');

    store.appendEvent(
      evt(projectId, conversationId, 'connector.removed', { connectorId, slug: 'claude-code' }),
    );
    const gone = store.db
      .prepare('SELECT COUNT(*) AS n FROM connectors WHERE id = ?')
      .get(connectorId) as { n: number };
    expect(gone.n).toBe(0);
  });

  it('projects settings.updated (upsert) and respects the secret tripwire', () => {
    const { projectId, conversationId } = setup();
    store.appendEvent(
      evt(projectId, conversationId, 'settings.updated', { key: 'theme', value: 'dark' }),
    );
    let row = store.db
      .prepare('SELECT value_json AS v FROM settings WHERE key = ?')
      .get('theme') as {
      v: string;
    };
    expect(JSON.parse(row.v)).toBe('dark');

    store.appendEvent(
      evt(projectId, conversationId, 'settings.updated', { key: 'theme', value: 'light' }),
    );
    row = store.db.prepare('SELECT value_json AS v FROM settings WHERE key = ?').get('theme') as {
      v: string;
    };
    expect(JSON.parse(row.v)).toBe('light'); // upsert

    // a secret-ish key is rejected by the event schema → the event never persists
    const before = store.getEvents(conversationId).length;
    expect(() =>
      store.appendEvent(
        evt(projectId, conversationId, 'settings.updated', { key: 'openai_api_key', value: 'x' }),
      ),
    ).toThrow();
    expect(store.getEvents(conversationId).length).toBe(before);
  });

  it('recordUserMessage still works through the generalized atomic path', () => {
    const { projectId, conversationId } = setup();
    const { message, event } = store.recordUserMessage({
      projectId,
      conversationId,
      text: 'hello amrita',
    });
    expect(message.role).toBe('user');
    expect(message.id).toBe(event.id); // the message row id is the event id
    const row = store.db
      .prepare(`SELECT role, json_extract(content_json, '$.text') AS t FROM messages WHERE id = ?`)
      .get(event.id) as { role: string; t: string };
    expect(row.role).toBe('user');
    expect(row.t).toBe('hello amrita');
    expect(store.searchMessages('amrita').length).toBeGreaterThanOrEqual(1); // searchable
  });

  it('projects the lane lifecycle into the lanes table', () => {
    const { projectId, conversationId } = setup();
    const laneId = newId();
    store.appendEvent(
      evt(projectId, conversationId, 'lane.spawned', { laneId, kind: 'claude-code' }),
    );
    const row = store.db
      .prepare('SELECT status, project_id AS p FROM lanes WHERE id = ?')
      .get(laneId) as {
      status: string;
      p: string;
    };
    expect(row.status).toBe('spawned');
    expect(row.p).toBe(projectId); // project/conversation taken from the envelope

    const mandate = {
      laneId,
      goal: 'fix bug',
      contextPack: { memory: [], files: [], decisions: [] },
      scope: { network: 'none' },
      budget: { maxTurns: 5 },
      approvals: 'forward',
      deliverables: [],
    };
    store.appendEvent(evt(projectId, conversationId, 'lane.mandate', mandate));
    const mrow = store.db
      .prepare('SELECT mandate_json AS m, budget_json AS b FROM lanes WHERE id = ?')
      .get(laneId) as { m: string; b: string };
    expect(JSON.parse(mrow.m).goal).toBe('fix bug');
    expect(JSON.parse(mrow.b).maxTurns).toBe(5);

    store.appendEvent(
      evt(projectId, conversationId, 'lane.progress', { note: 'working' }, { laneId }),
    );
    expect(
      (store.db.prepare('SELECT status FROM lanes WHERE id = ?').get(laneId) as { status: string })
        .status,
    ).toBe('running');

    const report = {
      laneId,
      summary: 'done',
      artifacts: [],
      decisions: [],
      tasks: [],
      followUps: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      exit: 'done',
    };
    store.appendEvent(evt(projectId, conversationId, 'lane.merge_report', report));
    const merged = store.db
      .prepare('SELECT status, merge_json AS m FROM lanes WHERE id = ?')
      .get(laneId) as { status: string; m: string };
    expect(merged.status).toBe('merging');
    expect(JSON.parse(merged.m).summary).toBe('done');

    store.appendEvent(evt(projectId, conversationId, 'lane.completed', { laneId, exit: 'done' }));
    expect(
      (store.db.prepare('SELECT status FROM lanes WHERE id = ?').get(laneId) as { status: string })
        .status,
    ).toBe('completed');
  });
});

describe('Store API (WO#1.4)', () => {
  function setup(): { projectId: string; conversationId: string } {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    return { projectId, conversationId };
  }

  it('write APIs persist an event and a projected row (createTask)', () => {
    const { projectId, conversationId } = setup();
    const { taskId, event } = store.createTask({
      projectId,
      conversationId,
      title: 'fix the PDF bug',
    });
    expect(event.type).toBe('task.created');
    const tasks = store.listTasks({ projectId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(taskId);
    expect(tasks[0]?.status).toBe('now');
    expect(tasks[0]?.conversationId).toBe(conversationId);
    // the event is in the log
    expect(store.getEvents(conversationId).some((e) => e.id === event.id)).toBe(true);
  });

  it('does not bypass appendEvent: a failed projection persists no event', () => {
    const { conversationId } = setup();
    const before = store.getEvents(conversationId).length;
    // a non-existent owning project → tasks FK fails inside the tx → full rollback
    expect(() =>
      store.createTask({ projectId: newId(), conversationId, title: 'orphan' }),
    ).toThrow();
    expect(store.getEvents(conversationId).length).toBe(before);
    expect(store.listTasks()).toHaveLength(0);
  });

  it('task provenance: externalRef + body persist, and the unique index blocks duplicates (ADR-0022)', () => {
    const { projectId, conversationId } = setup();
    const { taskId } = store.createTask({
      projectId,
      conversationId,
      title: '#7 · Crash on save',
      body: 'Imported from https://github.com/o/r/issues/7',
      externalRef: 'github:o/r#7',
    });
    const t = store.listTasks({ projectId }).find((x) => x.id === taskId);
    expect(t?.externalRef).toBe('github:o/r#7');
    expect(t?.body).toContain('issues/7');
    expect(store.listTaskExternalRefs(projectId)).toEqual(new Set(['github:o/r#7']));

    // the DB itself rejects a duplicate (project, externalRef) — idempotency backstop
    expect(() =>
      store.createTask({ projectId, conversationId, title: 'dup', externalRef: 'github:o/r#7' }),
    ).toThrow();
    expect(store.listTasks({ projectId })).toHaveLength(1);

    // a different project may import the same issue
    const otherProject = store.createProject({ slug: 'other-ref-proj', name: 'O' }).id;
    const otherConv = store.createConversation({ projectId: otherProject }).id;
    expect(() =>
      store.createTask({
        projectId: otherProject,
        conversationId: otherConv,
        title: 'same ref, other project',
        externalRef: 'github:o/r#7',
      }),
    ).not.toThrow();
  });

  it('task lifecycle through the API (update + complete)', () => {
    const { projectId, conversationId } = setup();
    const { taskId } = store.createTask({ projectId, conversationId, title: 't', status: 'later' });
    store.updateTask({ projectId, conversationId, taskId, title: 't2', status: 'now' });
    store.completeTask({ projectId, conversationId, taskId });
    const t = store.listTasks({ status: 'done' });
    expect(t).toHaveLength(1);
    expect(t[0]?.title).toBe('t2');
    expect(store.listTasks({ status: 'now' })).toHaveLength(0);
  });

  it('decisions: record, supersede, list current vs all, and history', () => {
    const { projectId, conversationId } = setup();
    const { decisionId: first } = store.recordDecision({
      projectId,
      conversationId,
      text: 'use SQLite',
    });
    const { decisionId: second } = store.supersedeDecision({
      projectId,
      conversationId,
      supersedesId: first,
      text: 'use SQLite + WAL',
    });
    expect(store.listDecisions({ projectId })).toHaveLength(1); // current only
    expect(store.listDecisions({ projectId })[0]?.id).toBe(second);
    expect(store.listDecisions({ projectId, includeSuperseded: true })).toHaveLength(2);
    const history = store.getDecisionHistory(second);
    expect(history.map((d) => d.id)).toEqual([first, second]); // oldest → newest
    // still append-only
    expect(() => store.db.prepare('DELETE FROM decisions WHERE id = ?').run(first)).toThrow(
      /append-only/,
    );
  });

  it('memory content API creates/updates and keeps user scope project-less', () => {
    const { projectId, conversationId } = setup();
    const { entryId } = store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'the brief: RTL-aware export',
      source: 'curated',
    });
    let hits = store.searchMemory('RTL');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe(entryId);
    expect(hits[0]?.charCount).toBe('the brief: RTL-aware export'.length);

    // update content
    store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'updated brief',
      entryId,
    });
    hits = store.searchMemory('updated');
    expect(hits[0]?.content).toBe('updated brief');

    // user-scope entry stores no project_id
    const { entryId: userEntry } = store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'user',
      content: 'global preference: dark mode',
    });
    const row = store.db
      .prepare('SELECT scope, project_id AS p FROM memory_entries WHERE id = ?')
      .get(userEntry) as { scope: string; p: string | null };
    expect(row.scope).toBe('user');
    expect(row.p).toBeNull();
  });

  it('memory consolidation merges into a result entry', () => {
    const { projectId, conversationId } = setup();
    const a = store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'note A',
    }).entryId;
    const b = store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'note B',
    }).entryId;
    const { resultEntryId } = store.consolidateMemoryEntries({
      projectId,
      conversationId,
      scope: 'project',
      content: 'A and B combined',
      sourceEntryIds: [a, b],
    });
    const row = store.db
      .prepare('SELECT content, source FROM memory_entries WHERE id = ?')
      .get(resultEntryId) as { content: string; source: string };
    expect(row.content).toBe('A and B combined');
    expect(row.source).toBe('consolidated');
    // source entries remain
    expect(store.searchMemory('note').length).toBe(2);
  });

  it('settings API upserts and refuses secret-ish keys (no secret ever stored)', () => {
    const { projectId, conversationId } = setup();
    store.updateSetting({ projectId, conversationId, key: 'public_url', value: 'https://x' });
    expect(store.getSetting('public_url')).toBe('https://x');
    store.updateSetting({ projectId, conversationId, key: 'public_url', value: 'https://y' });
    expect(store.getSetting('public_url')).toBe('https://y');
    expect(store.getSetting('missing')).toBeUndefined();

    const before = store.getEvents(conversationId).length;
    expect(() =>
      store.updateSetting({ projectId, conversationId, key: 'openai_api_key', value: 'x' }),
    ).toThrow();
    expect(store.getEvents(conversationId).length).toBe(before); // not persisted
  });

  it('connector API: install, update, list/get, remove', () => {
    const { projectId, conversationId } = setup();
    const { connectorId } = store.installConnector({
      projectId,
      conversationId,
      slug: 'claude-code',
      kind: 'cli',
    });
    expect(store.getConnector('claude-code')?.status).toBe('needs_setup');
    store.updateConnector({
      projectId,
      conversationId,
      connectorId,
      slug: 'claude-code',
      status: 'ready',
    });
    expect(store.getConnector('claude-code')?.status).toBe('ready');
    expect(store.listConnectors()).toHaveLength(1);
    store.removeConnector({ projectId, conversationId, connectorId, slug: 'claude-code' });
    expect(store.listConnectors()).toHaveLength(0);
  });

  it('provider account API: connect creates the row, health transitions, never a secret', () => {
    const { projectId, conversationId } = setup();
    const { accountId } = store.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    const accounts = store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.secretRef).toBeNull(); // no secret value/ref set via events
    expect(store.getAccountHealth(accountId)?.health).toBe('connected');

    store.markProviderDegraded({
      projectId,
      conversationId,
      provider: 'anthropic',
      accountId,
      reason: 'credit exhausted',
    });
    expect(store.getAccountHealth(accountId)?.health).toBe('degraded');
    expect(store.getAccountHealth(accountId)?.healthReason).toBe('credit exhausted');

    store.markProviderRestored({ projectId, conversationId, provider: 'anthropic', accountId });
    expect(store.getAccountHealth(accountId)?.health).toBe('restored');
    expect(store.listAccounts()[0]?.secretRef).toBeNull(); // still no secret
  });

  it('getConversationTree walks parent_id lineage', () => {
    const projectId = project();
    const root = store.createConversation({ projectId, title: 'root' }).id;
    const child = store.createConversation({ projectId, title: 'child', parentId: root }).id;
    const grandchild = store.createConversation({
      projectId,
      title: 'grandchild',
      parentId: child,
    }).id;
    const otherRoot = store.createConversation({ projectId, title: 'other' }).id;

    const tree = store.getConversationTree(root);
    const ids = tree.map((c) => c.id);
    expect(ids).toContain(root);
    expect(ids).toContain(child);
    expect(ids).toContain(grandchild);
    expect(ids).not.toContain(otherRoot);
    expect(tree.find((c) => c.id === child)?.parentId).toBe(root);
  });

  it('listLanes reads already-projected lane rows with filters', () => {
    const { projectId, conversationId } = setup();
    const laneId = newId();
    store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      origin: 'agent',
      type: 'lane.spawned',
      payload: { laneId, kind: 'claude-code' },
    } as Parameters<Store['appendEvent']>[0]);
    expect(store.listLanes({ projectId })).toHaveLength(1);
    expect(store.listLanes({ status: 'spawned' })[0]?.id).toBe(laneId);
    expect(store.listLanes({ status: 'completed' })).toHaveLength(0);
  });

  it('projects, uniquely claims, correlates, looks up, and replays lane metadata', () => {
    const { projectId, conversationId } = setup();
    const idempotencyKey = `rpc:${newId()}`;
    const groupId = newId();
    const verifiesLaneId = newId();
    const firstLaneId = newId();
    store.appendEvent(
      unsealed(projectId, conversationId, 'lane.spawned', {
        laneId: firstLaneId,
        kind: 'codex',
        idempotencyKey,
        groupId,
        role: 'qa',
        verifiesLaneId,
      }),
    );

    expect(store.getLane(firstLaneId)).toMatchObject({
      idempotencyKey,
      groupId,
      role: 'qa',
      verifiesLaneId,
    });
    expect(store.getLaneByIdempotencyKey(idempotencyKey)?.id).toBe(firstLaneId);
    expect(store.listLanes({ groupId }).map((lane) => lane.id)).toEqual([firstLaneId]);
    expect(store.listLanes({ verifiesLaneId }).map((lane) => lane.id)).toEqual([firstLaneId]);

    const eventsBefore = store.getEvents(conversationId).length;
    expect(() =>
      store.appendEvent(
        unsealed(projectId, conversationId, 'lane.spawned', {
          laneId: newId(),
          kind: 'codex',
          idempotencyKey,
        }),
      ),
    ).toThrow(/unique/i);
    expect(store.getEvents(conversationId)).toHaveLength(eventsBefore);
    expect(store.listLanes({ projectId })).toHaveLength(1);

    store.rebuildProjections();
    expect(store.getLaneByIdempotencyKey(idempotencyKey)).toMatchObject({
      id: firstLaneId,
      groupId,
      role: 'qa',
      verifiesLaneId,
    });
  });

  it('spilled file is written only after commit (no orphan on rollback)', () => {
    const { projectId, conversationId } = setup();
    const big = 'y'.repeat(40_000);
    // success path: file exists after commit
    const ev = store.appendEvent({
      id: newId(),
      ts: new Date().toISOString(),
      projectId,
      conversationId,
      origin: 'agent',
      type: 'tool.completed',
      payload: { toolCallId: 'tc', result: { result: big, isError: false } },
    } as Parameters<Store['appendEvent']>[0]);
    const path =
      ev.type === 'tool.completed' ? (ev.payload.result.spilledArtifactId as string) : '';
    const filePath = (
      store.db.prepare('SELECT path AS p FROM artifacts WHERE id = ?').get(path) as { p: string }
    ).p;
    expect(existsSync(filePath)).toBe(true);

    // rollback path: a spill whose event insert fails (bad conversation FK) writes no file
    const artifactsBefore = (
      store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }
    ).n;
    expect(() =>
      store.appendEvent({
        id: newId(),
        ts: new Date().toISOString(),
        projectId,
        conversationId: newId(), // no such conversation → events FK fails
        origin: 'agent',
        type: 'tool.completed',
        payload: { toolCallId: 'tc2', result: { result: big, isError: false } },
      } as Parameters<Store['appendEvent']>[0]),
    ).toThrow();
    const artifactsAfter = (
      store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get() as { n: number }
    ).n;
    expect(artifactsAfter).toBe(artifactsBefore); // artifact row rolled back too
  });
});

describe('secure config binding + memory FTS (WO#1.5)', () => {
  function connectedAccount(): { projectId: string; conversationId: string; accountId: string } {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    const { accountId } = store.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    return { projectId, conversationId, accountId };
  }

  it('binds an env-NAME secret ref and stores only the name', () => {
    const { accountId } = connectedAccount();
    expect(store.getAccountSecretRef(accountId)).toBeNull();
    store.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
    expect(store.getAccountSecretRef(accountId)).toBe('ANTHROPIC_API_KEY');
    const acc = store.listAccounts().find((a) => a.id === accountId);
    expect(acc?.secretRef).toBe('ANTHROPIC_API_KEY');
    expect(acc?.secretRef).not.toMatch(/[a-z]/); // an env-NAME, never a secret value
  });

  it('rejects non-env-name / secret-like refs and persists nothing', () => {
    const { accountId } = connectedAccount();
    expect(() => store.bindAccountSecretRef(accountId, 'not-an-env-name')).toThrow();
    expect(() => store.bindAccountSecretRef(accountId, 'lowercase_key')).toThrow();
    expect(() => store.bindAccountSecretRef(accountId, 'NOUNDERSCORE')).toThrow();
    expect(store.getAccountSecretRef(accountId)).toBeNull();
  });

  it('binding a missing account throws', () => {
    expect(() => store.bindAccountSecretRef(newId(), 'OPENAI_API_KEY')).toThrow(/no such account/);
  });

  it('clears a secret ref', () => {
    const { accountId } = connectedAccount();
    store.bindAccountSecretRef(accountId, 'OPENAI_API_KEY');
    store.clearAccountSecretRef(accountId);
    expect(store.getAccountSecretRef(accountId)).toBeNull();
  });

  it('getProviderConfigStatus reflects secret-ref binding and health', () => {
    const { projectId, conversationId, accountId } = connectedAccount();
    expect(store.getProviderConfigStatus(accountId)).toBe('missing_secret_ref');
    store.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
    expect(store.getProviderConfigStatus(accountId)).toBe('healthy'); // bound + connected
    store.markProviderDegraded({
      projectId,
      conversationId,
      provider: 'anthropic',
      accountId,
      reason: 'credit exhausted',
    });
    expect(store.getProviderConfigStatus(accountId)).toBe('degraded');
    expect(store.getProviderConfigStatus(newId())).toBeUndefined();

    // bound but no positive/negative health yet → secret_ref_bound
    const ts = new Date().toISOString();
    const bare = newId();
    store.db
      .prepare(
        'INSERT INTO accounts (id, provider, auth_mode, secret_ref, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      )
      .run(bare, 'openai', 'api_key', 'OPENAI_API_KEY', ts, ts);
    expect(store.getProviderConfigStatus(bare)).toBe('secret_ref_bound');
  });

  it('provider events still never carry or mutate a secret value', () => {
    const { projectId, conversationId, accountId } = connectedAccount();
    store.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
    // a health event must not disturb secret_ref
    store.markProviderRestored({ projectId, conversationId, provider: 'anthropic', accountId });
    expect(store.getAccountSecretRef(accountId)).toBe('ANTHROPIC_API_KEY');
    // and no event in the log carries a secret_ref field
    for (const e of store.getEvents(conversationId)) {
      expect(JSON.stringify(e.payload)).not.toMatch(/secret_ref|secretRef/);
    }
  });

  it('memory FTS finds content and re-indexes after edit/consolidation', () => {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    const { entryId } = store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'the renderer handles RTL bidi text',
    });
    expect(store.searchMemory('bidi').map((h) => h.id)).toContain(entryId);
    expect(store.searchMemory('renderer')).toHaveLength(1);

    // edit content → FTS reflects the new content, drops the old
    store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'now about pagination',
      entryId,
    });
    expect(store.searchMemory('bidi')).toHaveLength(0);
    expect(store.searchMemory('pagination').map((h) => h.id)).toContain(entryId);

    // consolidation result is searchable
    const { resultEntryId } = store.consolidateMemoryEntries({
      projectId,
      conversationId,
      scope: 'project',
      content: 'merged summary of layout',
      sourceEntryIds: [entryId],
    });
    expect(store.searchMemory('layout').map((h) => h.id)).toContain(resultEntryId);
  });

  it('memory FTS honours scope/project filters and an empty query', () => {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'project note alpha',
    });
    store.putMemoryEntry({ projectId, conversationId, scope: 'user', content: 'user note alpha' });
    expect(store.searchMemory('alpha')).toHaveLength(2);
    expect(store.searchMemory('alpha', { scope: 'user' })).toHaveLength(1);
    expect(store.searchMemory('alpha', { projectId })).toHaveLength(1); // user entry has no project
    expect(store.searchMemory('!!!')).toHaveLength(0); // all-punctuation → []
  });

  it('memory FTS rebuilds deterministically after a 0002 down/up', () => {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    store.putMemoryEntry({
      projectId,
      conversationId,
      scope: 'project',
      content: 'persistent knowledge base entry',
    });
    expect(store.searchMemory('persistent')).toHaveLength(1);

    migrateDown(store.db, 1); // revert 0002 (drop the FTS table)
    expect(tableNames(store.db)).not.toContain('memory_entries_fts');
    migrateUp(store.db); // re-apply 0002; its up runs 'rebuild' over existing rows
    expect(store.searchMemory('persistent')).toHaveLength(1);
  });
});

describe('agent messages + context (WO#2.3)', () => {
  it('recordAgentMessage projects a role-agent row atomically and is searchable', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    store.recordUserMessage({ projectId, conversationId: c, text: 'fix the export bug' });
    const { message, event } = store.recordAgentMessage({
      projectId,
      conversationId: c,
      text: 'I fixed the RTL export rendering',
    });
    expect(event.type).toBe('message.agent');
    expect(message.role).toBe('agent');
    expect(message.id).toBe(event.id); // deterministic id == event id

    const msgs = store.listMessages(c);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(msgs[1]?.text).toContain('RTL');
    expect(store.searchMessages('RTL').some((h) => h.role === 'agent')).toBe(true);

    // event + message stay atomic: two of each, never one without the other
    expect(store.getEvents(c)).toHaveLength(2);
    const n = (
      store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(c) as {
        n: number;
      }
    ).n;
    expect(n).toBe(2);
  });

  it('listMessages respects a limit and ordering', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    store.recordUserMessage({ projectId, conversationId: c, text: 'first' });
    store.recordAgentMessage({ projectId, conversationId: c, text: 'second' });
    expect(store.listMessages(c).map((m) => m.text)).toEqual(['first', 'second']);
    expect(store.listMessages(c, { limit: 1 }).map((m) => m.text)).toEqual(['first']);
  });
});

describe('channel pairings (WO#3.1)', () => {
  it('creates, claims, and links a channel identity; rejects double-claim', () => {
    const projectId = project();
    const c = store.createConversation({ projectId }).id;
    const { code } = store.createPairing({ channel: 'telegram', projectId, conversationId: c });
    expect(code).toBeTypeOf('string');

    expect(store.getChannelLink('telegram', '555')).toBeUndefined();
    const link = store.consumePairing({ channel: 'telegram', code, externalUserId: '555' });
    expect(link).toEqual({ projectId, conversationId: c });
    expect(store.getChannelLink('telegram', '555')).toEqual({ projectId, conversationId: c });

    // already claimed / unknown
    expect(() =>
      store.consumePairing({ channel: 'telegram', code, externalUserId: '777' }),
    ).toThrow(/already claimed/);
    expect(() =>
      store.consumePairing({ channel: 'telegram', code: 'NOPE', externalUserId: '777' }),
    ).toThrow(/unknown pairing code/);

    const list = store.listPairings('telegram');
    expect(list).toHaveLength(1);
    expect(list[0]?.claimedBy).toBe('555');
    // pairings carry no secret value
    expect(JSON.stringify(list)).not.toMatch(/sk-|password/i);
  });
});

describe('project companion (ADR-0018)', () => {
  function ctx(): { projectId: string; conversationId: string } {
    const projectId = project();
    const conversationId = store.createConversation({ projectId }).id;
    return { projectId, conversationId };
  }

  it('brief is a full-document upsert, rebuilt by the latest brief.updated', () => {
    const c = ctx();
    expect(store.getBrief(c.projectId)).toBeUndefined();
    store.upsertBrief({
      ...c,
      goal: 'ship the CRM',
      successCriteria: ['login works'],
      scope: ['web app'],
      noScope: ['mobile app'],
    });
    let brief = store.getBrief(c.projectId);
    expect(brief).toMatchObject({
      goal: 'ship the CRM',
      successCriteria: ['login works'],
      scope: ['web app'],
      noScope: ['mobile app'],
      audience: null,
    });

    store.upsertBrief({
      ...c,
      goal: 'ship the CRM v2',
      audience: 'small agencies',
      successCriteria: ['login works', 'export works'],
    });
    brief = store.getBrief(c.projectId);
    expect(brief?.goal).toBe('ship the CRM v2');
    expect(brief?.audience).toBe('small agencies');
    expect(brief?.successCriteria).toEqual(['login works', 'export works']);
    expect(brief?.scope).toEqual([]); // full-document semantics: omitted = empty
    // exactly one row per project
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM project_briefs WHERE project_id = ?')
      .get(c.projectId) as { n: number };
    expect(count.n).toBe(1);
  });

  it('question lifecycle: open → resolve needs evidence; drop needs a reason', () => {
    const c = ctx();
    const { questionId } = store.openQuestion({ ...c, text: 'which auth provider?' });
    expect(store.listQuestions({ projectId: c.projectId, status: 'open' })).toHaveLength(1);

    // resolving with NEITHER a note nor a decision link is rejected by the protocol
    expect(() => store.resolveQuestion({ ...c, questionId })).toThrow();

    // resolving with a decision link works and records provenance
    const { decisionId } = store.recordDecision({ ...c, text: 'use magic links' });
    store.resolveQuestion({ ...c, questionId, resolvedByDecisionId: decisionId });
    const resolved = store.listQuestions({ projectId: c.projectId, status: 'resolved' });
    expect(resolved[0]).toMatchObject({ id: questionId, resolvedByDecisionId: decisionId });

    // a decision link that doesn't exist rolls the event back (trigger)
    const q2 = store.openQuestion({ ...c, text: 'hosting?' });
    const before = store.getEvents(c.conversationId).length;
    expect(() =>
      store.resolveQuestion({ ...c, questionId: q2.questionId, resolvedByDecisionId: newId() }),
    ).toThrow(/does not reference a decision/);
    expect(store.getEvents(c.conversationId)).toHaveLength(before); // event rolled back too

    // dropping requires a reason (typed input) and records it
    store.dropQuestion({ ...c, questionId: q2.questionId, reason: 'out of scope for v1' });
    expect(store.listQuestions({ projectId: c.projectId, status: 'dropped' })[0]?.dropReason).toBe(
      'out of scope for v1',
    );
  });

  it('risk lifecycle mirrors questions, with a tiny optional severity', () => {
    const c = ctx();
    const { riskId } = store.openRisk({ ...c, text: 'sqlite file corruption', severity: 'high' });
    expect(store.listRisks({ projectId: c.projectId, status: 'open' })[0]).toMatchObject({
      severity: 'high',
      status: 'open',
    });
    store.resolveRisk({ ...c, riskId, resolution: 'WAL + backups in place' });
    expect(store.listRisks({ projectId: c.projectId, status: 'resolved' })[0]?.resolution).toBe(
      'WAL + backups in place',
    );
    // invalid severity is rejected by the protocol schema
    expect(() => store.openRisk({ ...c, text: 'x', severity: 'huge' as 'high' })).toThrow();
  });

  it('milestones: create/update/complete, and tasks link to them (trigger-checked)', () => {
    const c = ctx();
    const { milestoneId } = store.createMilestone({
      ...c,
      title: 'Alpha',
      targetDate: '2026-07-01',
    });
    expect(store.listMilestones({ projectId: c.projectId })[0]).toMatchObject({
      title: 'Alpha',
      status: 'planned',
      targetDate: '2026-07-01',
    });
    store.updateMilestone({ ...c, milestoneId, status: 'active' });
    expect(store.listMilestones({ projectId: c.projectId, status: 'active' })).toHaveLength(1);

    // a task can be created linked, and re-linked / unlinked via update
    const { taskId } = store.createTask({ ...c, title: 'build login', milestoneId });
    expect(store.listTasks({ projectId: c.projectId })[0]?.milestoneId).toBe(milestoneId);
    store.updateTask({ ...c, taskId, milestoneId: null });
    expect(store.listTasks({ projectId: c.projectId })[0]?.milestoneId).toBeNull();

    // linking to a nonexistent milestone rolls back (trigger), event included
    const before = store.getEvents(c.conversationId).length;
    expect(() => store.updateTask({ ...c, taskId, milestoneId: newId() })).toThrow(
      /milestone does not exist/,
    );
    expect(store.getEvents(c.conversationId)).toHaveLength(before);

    store.completeMilestone({ ...c, milestoneId });
    expect(store.listMilestones({ projectId: c.projectId })[0]?.status).toBe('done');
    // bad targetDate shape rejected by protocol
    expect(() => store.createMilestone({ ...c, title: 'x', targetDate: 'July 1' })).toThrow();
  });

  it('listProjectEvents derives a bounded, newest-first timeline across conversations', () => {
    const projectId = project();
    const conv1 = store.createConversation({ projectId }).id;
    const conv2 = store.createConversation({ projectId }).id;
    store.recordUserMessage({ projectId, conversationId: conv1, text: 'first' });
    store.openQuestion({ projectId, conversationId: conv2, text: 'why?' });
    store.createMilestone({ projectId, conversationId: conv1, title: 'M1' });

    const timeline = store.listProjectEvents(projectId);
    expect(timeline.length).toBeGreaterThanOrEqual(3);
    // newest first, and it spans both conversations
    expect(timeline[0]?.type).toBe('milestone.created');
    expect(new Set(timeline.map((e) => e.conversationId)).size).toBe(2);
    // bounded
    expect(store.listProjectEvents(projectId, { limit: 2 })).toHaveLength(2);
    // other projects' events are not included
    const otherProject = store.createProject({ slug: 'timeline-other', name: 'Other' }).id;
    expect(store.listProjectEvents(otherProject)).toHaveLength(0);
  });
});

describe('brand memory + preview approvals (ADR-0020)', () => {
  let n = 0;
  function ctx(): { projectId: string; conversationId: string } {
    const projectId = store.createProject({ slug: `brand-${++n}`, name: 'Brand' }).id;
    const conversationId = store.createConversation({ projectId }).id;
    return { projectId, conversationId };
  }

  it('brand is a full-document upsert; no row means honest empty; empty writes rejected', () => {
    const c = ctx();
    expect(store.getBrand(c.projectId)).toBeUndefined();

    // an empty brand write is rejected by the protocol refine — nothing lands
    expect(() => store.upsertBrand({ ...c })).toThrow(/substantive field/);
    expect(store.getBrand(c.projectId)).toBeUndefined();

    store.upsertBrand({
      ...c,
      name: 'Nimbus CRM',
      tone: 'premium, calm',
      palette: ['#0EA5E9 cyan accents', 'near-black surfaces'],
      doNotUse: ['no neon gradients'],
    });
    let brand = store.getBrand(c.projectId);
    expect(brand).toMatchObject({
      name: 'Nimbus CRM',
      tone: 'premium, calm',
      palette: ['#0EA5E9 cyan accents', 'near-black surfaces'],
      doNotUse: ['no neon gradients'],
      audience: null,
    });

    // full-document semantics: a second write replaces, omitted = empty/null
    store.upsertBrand({ ...c, name: 'Nimbus', audience: 'small agencies' });
    brand = store.getBrand(c.projectId);
    expect(brand?.name).toBe('Nimbus');
    expect(brand?.audience).toBe('small agencies');
    expect(brand?.tone).toBeNull();
    expect(brand?.palette).toEqual([]);
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM project_brands WHERE project_id = ?')
      .get(c.projectId) as { n: number };
    expect(count.n).toBe(1);
  });

  it('brand never leaks across projects', () => {
    const a = ctx();
    const b = ctx();
    store.upsertBrand({ ...a, name: 'A-brand' });
    expect(store.getBrand(a.projectId)?.name).toBe('A-brand');
    expect(store.getBrand(b.projectId)).toBeUndefined();
  });

  it('preview approvals upsert by (project, previewId) and stay project-scoped', () => {
    const a = ctx();
    const b = ctx();
    const previewId = `html-preview:${a.projectId}`;
    expect(store.listPreviewApprovals(a.projectId)).toEqual([]);

    store.approvePreview({ ...a, previewId, contentHash: 'hash-1' });
    expect(store.listPreviewApprovals(a.projectId)[0]).toMatchObject({
      previewId,
      contentHash: 'hash-1',
    });
    // re-approval after content drift upserts (one row, new hash)
    store.approvePreview({ ...a, previewId, contentHash: 'hash-2' });
    const rows = store.listPreviewApprovals(a.projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentHash).toBe('hash-2');
    // never visible from another project
    expect(store.listPreviewApprovals(b.projectId)).toEqual([]);
  });
});

// ── ADR-0044: the board — activating the dormant write path ──────────────────
describe('the task board (ADR-0044)', () => {
  function ctx(): { projectId: string; conversationId: string } {
    const projectId = project();
    return { projectId, conversationId: store.createConversation({ projectId }).id };
  }

  it('creates a task with owner, due date, priority and an order key', () => {
    const c = ctx();
    const { taskId } = store.createTask({
      ...c,
      title: 'File the permit',
      owner: 'Dana',
      dueDate: '2026-09-01',
      priority: 'high',
      orderKey: 'a0',
    });
    const t = store.listTasks({ projectId: c.projectId }).find((x) => x.id === taskId);
    expect(t).toMatchObject({
      owner: 'Dana',
      dueDate: '2026-09-01',
      priority: 'high',
      orderKey: 'a0',
      blockedReason: null,
    });
  });

  it('moves a card between columns — the drag, as one event on one row', () => {
    const c = ctx();
    const { taskId } = store.createTask({ ...c, title: 'x', status: 'later', orderKey: 'a0' });
    store.updateTask({ ...c, taskId, status: 'now', orderKey: 'a5' });

    const t = store.listTasks({ projectId: c.projectId })[0];
    expect(t?.status).toBe('now');
    expect(t?.orderKey).toBe('a5');
    // exactly one task.updated — no sibling re-indexing
    const updates = store.getEvents(c.conversationId).filter((e) => e.type === 'task.updated');
    expect(updates).toHaveLength(1);
  });

  it('CLEARS a field with null, and leaves it alone when absent', () => {
    const c = ctx();
    const { taskId } = store.createTask({
      ...c,
      title: 'x',
      owner: 'Dana',
      priority: 'high',
      blockedReason: 'waiting on the permit',
    });

    // absent = leave alone
    store.updateTask({ ...c, taskId, title: 'y' });
    let t = store.listTasks({ projectId: c.projectId })[0];
    expect(t?.owner).toBe('Dana');
    expect(t?.blockedReason).toBe('waiting on the permit');

    // null = clear (un-assign, unblock)
    store.updateTask({ ...c, taskId, owner: null, blockedReason: null });
    t = store.listTasks({ projectId: c.projectId })[0];
    expect(t?.owner).toBeNull();
    expect(t?.blockedReason).toBeNull();
    expect(t?.priority).toBe('high'); // untouched
  });

  it('models "Waiting" WITHOUT widening the status enum', () => {
    const c = ctx();
    const { taskId } = store.createTask({ ...c, title: 'x', status: 'now' });
    store.updateTask({ ...c, taskId, blockedReason: 'the arts council has not replied' });

    const t = store.listTasks({ projectId: c.projectId })[0];
    // still a legal status — the enum is untouched (SQLite cannot alter a CHECK)
    expect(t?.status).toBe('now');
    // …and yet it is unambiguously in the Waiting column, with the REASON
    expect(t?.blockedReason).toBe('the arts council has not replied');
  });

  it('rejects a bad date and a bad priority at the SQL layer', () => {
    const c = ctx();
    expect(() => store.createTask({ ...c, title: 'x', dueDate: '3rd of March' })).toThrow();
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: deliberately bypassing the type to test the CHECK
      store.createTask({ ...c, title: 'y', priority: 'urgent' as any }),
    ).toThrow();
  });

  it('orders the board by order key, with an unranked task last', () => {
    const c = ctx();
    store.createTask({ ...c, title: 'never dragged' });
    store.createTask({ ...c, title: 'second', orderKey: 'b' });
    store.createTask({ ...c, title: 'first', orderKey: 'a' });

    expect(store.listTasks({ projectId: c.projectId }).map((t) => t.title)).toEqual([
      'first',
      'second',
      'never dragged',
    ]);
  });

  it('replays a pre-0044 task.created event (no board fields) unchanged', () => {
    const c = ctx();
    store.appendEvent(
      unsealed(c.projectId, c.conversationId, 'task.created', {
        taskId: newId(),
        projectId: c.projectId,
        conversationId: c.conversationId,
        title: 'legacy task',
      }),
    );
    const t = store.listTasks({ projectId: c.projectId })[0];
    expect(t?.title).toBe('legacy task');
    expect(t?.owner).toBeNull();
    expect(t?.priority).toBeNull();
    expect(t?.orderKey).toBeNull();
  });
});

// ── ADR-0044: the charter (constraints as fuel) ──────────────────────────────
describe('the charter (ADR-0044)', () => {
  function ctx(): { projectId: string; conversationId: string } {
    const projectId = project();
    return { projectId, conversationId: store.createConversation({ projectId }).id };
  }

  it('persists the finish line, constraints and decision rights', () => {
    const c = ctx();
    store.upsertBrief({
      ...c,
      goal: 'Run the Unity Festival',
      successCriteria: ['500 attendees'],
      scope: [],
      noScope: [],
      finishLine: 'the festival happens and books at $15K net',
      constraints: [
        { kind: 'budget', text: '$15K net', hard: true },
        { kind: 'resource', text: 'one organizer', hard: false },
      ],
      decisionRights: [{ area: 'vendor list', approver: 'the arts council' }],
    });

    const b = store.getBrief(c.projectId);
    expect(b?.finishLine).toBe('the festival happens and books at $15K net');
    expect(b?.constraints).toEqual([
      { kind: 'budget', text: '$15K net', hard: true },
      { kind: 'resource', text: 'one organizer', hard: false },
    ]);
    expect(b?.decisionRights).toEqual([{ area: 'vendor list', approver: 'the arts council' }]);
  });

  it('defaults to an EMPTY charter, never an invented one', () => {
    const c = ctx();
    store.upsertBrief({ ...c, goal: 'Ship v1', successCriteria: [], scope: [], noScope: [] });
    const b = store.getBrief(c.projectId);
    expect(b?.finishLine).toBeNull();
    expect(b?.constraints).toEqual([]);
    expect(b?.decisionRights).toEqual([]);
  });

  it('is a FULL-document upsert — a later write without a charter clears it', () => {
    const c = ctx();
    store.upsertBrief({
      ...c,
      goal: 'g',
      successCriteria: [],
      scope: [],
      noScope: [],
      finishLine: 'done when shipped',
      constraints: [{ kind: 'date', text: 'by October', hard: true }],
    });
    // ADR-0018's brief semantics: the event carries the WHOLE document, so
    // replaying the log must rebuild the row verbatim — which means an update
    // that omits the charter really does drop it. Callers must send it back.
    store.upsertBrief({ ...c, goal: 'g2', successCriteria: [], scope: [], noScope: [] });
    const b = store.getBrief(c.projectId);
    expect(b?.goal).toBe('g2');
    expect(b?.finishLine).toBeNull();
    expect(b?.constraints).toEqual([]);
  });

  it('replays a pre-0044 brief.updated event (no charter fields) unchanged', () => {
    const c = ctx();
    // exactly the payload shape shipped before ADR-0044
    store.appendEvent(
      unsealed(c.projectId, c.conversationId, 'brief.updated', {
        projectId: c.projectId,
        goal: 'legacy goal',
        successCriteria: ['x'],
        scope: [],
        noScope: [],
      }),
    );
    const b = store.getBrief(c.projectId);
    expect(b?.goal).toBe('legacy goal');
    expect(b?.constraints).toEqual([]); // the DEFAULT '[]', not a crash
    expect(b?.decisionRights).toEqual([]);
    expect(b?.finishLine).toBeNull();
  });
});

// ── ADR-0044: the Inbox — the one triage queue ───────────────────────────────
describe('inbox (ADR-0044)', () => {
  function ctx(): { projectId: string; conversationId: string } {
    const projectId = project();
    return { projectId, conversationId: store.createConversation({ projectId }).id };
  }

  it('captures a proposal as PENDING — it is not project truth yet', () => {
    const c = ctx();
    const { itemId } = store.captureInboxItem({
      ...c,
      origin: 'agent',
      text: 'the venue deposit is due March 3rd',
      suggestedKind: 'task',
      suggested: { title: 'Pay the venue deposit', dueDate: '2026-03-03' },
      rationale: 'the operator committed to a date',
      confidence: 'high',
    });

    const item = store.getInboxItem(itemId);
    expect(item?.status).toBe('pending');
    expect(item?.origin).toBe('agent');
    expect(item?.suggestedKind).toBe('task');
    expect(item?.suggested).toEqual({ title: 'Pay the venue deposit', dueDate: '2026-03-03' });
    expect(item?.confidence).toBe('high');
    // and crucially: nothing landed in the real aggregate
    expect(store.listTasks({ projectId: c.projectId })).toHaveLength(0);
  });

  it('records a promotion and what it BECAME', () => {
    const c = ctx();
    const { itemId } = store.captureInboxItem({ ...c, origin: 'user', text: 'book the band' });
    const { taskId } = store.createTask({ ...c, title: 'Book the band' });
    store.triageInboxItem({ ...c, itemId, promotedKind: 'task', promotedId: taskId });

    const item = store.getInboxItem(itemId);
    expect(item?.status).toBe('triaged');
    expect(item?.promotedKind).toBe('task');
    expect(item?.promotedId).toBe(taskId);
  });

  it('REFUSES a silent promotion — a triage must name what it became', () => {
    const c = ctx();
    const { itemId } = store.captureInboxItem({ ...c, origin: 'user', text: 'x' });
    // Bypass the store API and emit the event with a promotion that names nothing.
    expect(() =>
      store.db.prepare("UPDATE inbox_items SET status = 'triaged' WHERE id = ?").run(itemId),
    ).toThrow(/CHECK constraint/);
    expect(store.getInboxItem(itemId)?.status).toBe('pending');
  });

  it('REFUSES a silent dismissal — a reason is required', () => {
    const c = ctx();
    const { itemId } = store.captureInboxItem({ ...c, origin: 'user', text: 'x' });
    expect(() =>
      store.db.prepare("UPDATE inbox_items SET status = 'dismissed' WHERE id = ?").run(itemId),
    ).toThrow(/CHECK constraint/);

    // …and with a reason it settles cleanly.
    store.dismissInboxItem({ ...c, itemId, reason: 'already handled offline' });
    const item = store.getInboxItem(itemId);
    expect(item?.status).toBe('dismissed');
    expect(item?.dismissReason).toBe('already handled offline');
  });

  it('lists the pending queue for a project, oldest first', () => {
    const c = ctx();
    const a = store.captureInboxItem({ ...c, origin: 'user', text: 'first' });
    store.captureInboxItem({ ...c, origin: 'lane', text: 'second' });
    store.dismissInboxItem({ ...c, itemId: a.itemId, reason: 'nope' });

    const pending = store.listInboxItems({ projectId: c.projectId, status: 'pending' });
    expect(pending.map((i) => i.text)).toEqual(['second']);
    expect(store.listInboxItems({ projectId: c.projectId })).toHaveLength(2);
  });

  it('carries provenance to the exact message that produced it', () => {
    const c = ctx();
    const user = store.recordUserMessage({ ...c, text: 'the deposit is due March 3rd' });
    const { itemId } = store.captureInboxItem({
      ...c,
      origin: 'agent',
      text: 'deposit due March 3rd',
      sourceMessageId: user.message.id,
    });
    expect(store.getInboxItem(itemId)?.sourceMessageId).toBe(user.message.id);
  });
});

// ── ADR-0044: views are projections (the executable fitness function) ────────
describe('projection rebuild', () => {
  /** Every table whose SOLE writer is applyEventProjection. */
  const DERIVED_TABLES = [
    'messages',
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
    'connectors',
    'inbox_items',
    'phases',
    'project_publications',
  ];

  function snapshot(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const t of DERIVED_TABLES) {
      out[t] = store.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();
    }
    out.conversations = store.db
      .prepare('SELECT id, archived_at FROM conversations ORDER BY rowid')
      .all();
    return out;
  }

  /** A project exercising every event-derived aggregate at once. */
  function populate(): { projectId: string; conversationId: string } {
    const projectId = project();
    const conversationId = store.createConversation({ projectId, title: 'main' }).id;
    const c = { projectId, conversationId };

    const user = store.recordUserMessage({ ...c, text: 'ship the festival' });
    store.recordAgentMessage({ ...c, text: 'on it' });

    store.upsertBrief({
      ...c,
      goal: 'Run the Unity Festival',
      audience: 'the town',
      successCriteria: ['500 attendees', '$15K net'],
      scope: ['the event'],
      noScope: ['a second stage'],
      finishLine: 'the festival happens and books at $15K net',
      constraints: [{ kind: 'budget', text: '$15K net', hard: true }],
      decisionRights: [{ area: 'vendors', approver: 'the arts council' }],
    });
    store.upsertBrand({ ...c, name: 'Unity', palette: ['warm'] });
    store.approvePreview({ ...c, previewId: 'html-preview:x', contentHash: 'abc123' });

    const { phaseId } = store.createPhase({ ...c, title: 'Permits phase', orderKey: 'n' });
    store.updatePhase({ ...c, phaseId, status: 'active' });
    const { milestoneId } = store.createMilestone({
      ...c,
      title: 'Permits',
      targetDate: '2026-09-01',
    });
    const { taskId } = store.createTask({
      ...c,
      title: 'File the permit',
      milestoneId,
      owner: 'Dana',
      dueDate: '2026-09-01',
      priority: 'high',
      orderKey: 'a0',
      phaseId,
      certainty: 'stated',
    });
    store.updateTask({
      ...c,
      taskId,
      status: 'later',
      title: 'File the permit (renamed)',
      orderKey: 'a5',
      blockedReason: 'waiting on the council',
    });
    store.updateTask({
      ...c,
      taskId,
      blockedReason: null,
      owner: null,
      reason: 'the council replied',
      derivedFrom: [{ kind: 'decision', label: 'Riverside Park it is' }],
    });
    const done = store.createTask({ ...c, title: 'Book the band' });
    store.completeTask({ ...c, taskId: done.taskId });

    const { decisionId } = store.recordDecision({
      ...c,
      text: 'Riverside Park',
      sourceMessageId: user.message.id,
    });
    store.supersedeDecision({ ...c, supersedesId: decisionId, text: 'Town Square instead' });

    const q = store.openQuestion({ ...c, text: 'who signs the permit?' });
    store.resolveQuestion({ ...c, questionId: q.questionId, resolvedByDecisionId: decisionId });
    const q2 = store.openQuestion({ ...c, text: 'insurance?' });
    store.dropQuestion({ ...c, questionId: q2.questionId, reason: 'handled offline' });

    const r = store.openRisk({ ...c, text: 'rain', severity: 'high' });
    store.resolveRisk({ ...c, riskId: r.riskId, resolution: 'tent booked' });

    store.putMemoryEntry({
      ...c,
      scope: 'project',
      content: 'vendor prefers cash',
      source: 'chat',
    });
    store.completeMilestone({ ...c, milestoneId });

    // the Inbox, in all three terminal states (ADR-0044) — so replay-equivalence
    // covers the new aggregate too, not just the ADR-0018 ones.
    store.captureInboxItem({
      ...c,
      origin: 'agent',
      text: 'deposit due March 3rd',
      suggestedKind: 'task',
      suggested: { title: 'Pay the deposit' },
      confidence: 'high',
    });
    const promoted = store.captureInboxItem({ ...c, origin: 'lane', text: 'lane found a task' });
    store.triageInboxItem({
      ...c,
      itemId: promoted.itemId,
      promotedKind: 'task',
      promotedId: done.taskId,
    });
    const junk = store.captureInboxItem({ ...c, origin: 'user', text: 'noise' });
    store.dismissInboxItem({ ...c, itemId: junk.itemId, reason: 'not relevant' });
    store.activateProject({ ...c, phaseCount: 1, milestoneCount: 1, taskCount: 2 });
    return c;
  }

  it('replays the whole log into an IDENTICAL read model (views are projections)', () => {
    const { projectId, conversationId } = populate();
    store.appendEvent(unsealed(projectId, conversationId, 'conversation.archived', {}));

    const before = snapshot();
    const { events } = store.rebuildProjections();
    const after = snapshot();

    expect(events).toBeGreaterThan(15); // the log really was replayed
    expect(after).toEqual(before);
  });

  it('is idempotent — rebuilding twice changes nothing', () => {
    populate();
    store.rebuildProjections();
    const once = snapshot();
    store.rebuildProjections();
    expect(snapshot()).toEqual(once);
  });

  it('leaves the append-only decisions trigger armed afterwards', () => {
    const { projectId } = populate();
    store.rebuildProjections();
    // The rebuild opens ADR-0038's per-project gate to clear `decisions`, then
    // clears it. If it leaked, decisions would silently become deletable.
    expect(() =>
      store.db.prepare('DELETE FROM decisions WHERE project_id = ?').run(projectId),
    ).toThrow(/append-only/);
    expect(
      store.db.prepare("SELECT * FROM settings WHERE key = 'cascade.project.delete'").get(),
    ).toBeUndefined();
  });

  it('does NOT delete non-derived state (projects and conversations survive)', () => {
    const c = populate();
    store.updateSetting({ ...c, key: 'providers.role.main', value: { provider: 'mock' } });
    store.rebuildProjections();

    // projects/conversations are created by DIRECT insert, not by the reducer —
    // a rebuild must never touch them, or it would delete what the log lacks.
    expect(store.listProjects()).toHaveLength(1);
    expect(store.listConversations(c.projectId)).toHaveLength(1);
    // settings ARE event-sourced (settings.updated), so they survive by replay.
    expect(store.getSetting('providers.role.main')).toEqual({ provider: 'mock' });
  });

  it('rolls the read model back if a replay fails (one transaction)', () => {
    const { projectId } = populate();
    const before = snapshot();
    const eventCount = store.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number };

    // Corrupt one stored payload so re-projecting it throws mid-replay. (This
    // makes the row permanently unparseable, so assert on raw SQL below — a
    // typed read of it would now throw too, which is itself correct behavior.)
    store.db
      .prepare(
        'UPDATE events SET payload_json = \'{"taskId":"nope"}\' WHERE type = \'task.created\'',
      )
      .run();
    expect(() => store.rebuildProjections()).toThrow();

    // Everything is exactly as it was — no half-rebuilt store.
    expect(snapshot()).toEqual(before);
    expect(store.listTasks({ projectId })).toHaveLength(2);
    expect(store.db.prepare('SELECT count(*) AS n FROM events').get()).toEqual(eventCount);
  });
});

describe('project timeline index (ADR-0044 / migration 0009)', () => {
  it('restores idx_events_project_ts, which the 0007 table rebuild dropped', () => {
    const idx = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_project_ts'")
      .get();
    expect(idx).toBeDefined();
  });

  it('uses the index for the project-timeline read instead of scanning', () => {
    const plan = store.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM events WHERE project_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?',
      )
      .all('p', 10) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(' ')).toContain('idx_events_project_ts');
  });
});

describe('corrupt DB quarantine on open (ST3)', () => {
  it('a non-database file is moved aside and open throws — not a crash-loop', () => {
    const dir = mkdtempSync(join(tmpdir(), 'amrita-corrupt-'));
    const path = join(dir, 'amrita.db');
    // Bytes that are definitely not a SQLite file.
    writeFileSync(path, 'this is not a database, it is garbage\n');
    expect(() => openStore({ path, spillDir: join(dir, 'artifacts') })).toThrow(/corrupt/i);
    // The garbage file was quarantined, so the ORIGINAL path is now free for a
    // fresh store on the next start (which is exactly how the crash-loop breaks).
    expect(existsSync(path)).toBe(false);
    const moved = readdirSync(dir).find((f) => f.startsWith('amrita.db.corrupt.'));
    expect(moved).toBeDefined();
    expect(readFileSync(join(dir, moved as string), 'utf8')).toContain('garbage');
    rmSync(dir, { recursive: true, force: true });
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
