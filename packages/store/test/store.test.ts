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

describe('migrations', () => {
  it('apply up, down, and up again (reversible)', () => {
    const db = new Database(':memory:');
    expect(currentVersion(db)).toBe(-1);

    expect(migrateUp(db)).toBe(1);
    expect(currentVersion(db)).toBe(0);
    // schema present
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('events');
    expect(names).toContain('messages');
    expect(names).toContain('messages_fts');

    expect(migrateDown(db)).toBe(1);
    expect(currentVersion(db)).toBe(-1);
    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'")
      .all();
    expect(after).toHaveLength(0);

    // up again — idempotent re-application
    expect(migrateUp(db)).toBe(1);
    expect(currentVersion(db)).toBe(0);
    expect(migrateUp(db)).toBe(0); // nothing left to apply
    db.close();
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
