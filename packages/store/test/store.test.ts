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
