import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated state dir for the whole suite.
const home = mkdtempSync(join(tmpdir(), 'amrita-test-'));
process.env.AMRITA_HOME = home;

const { ensureHome } = await import('../src/shared/paths.ts');
const { loadConfig, setConfigValue, setSecret, getSecret, redactSecret } = await import(
  '../src/shared/config.ts'
);
const { closeDb, hasFts } = await import('../src/core/store/db.ts');
const { createSession, appendMessage, getMessages, searchMessages, listSessions } = await import(
  '../src/core/store/sessions.ts'
);
const { resolveBinding, switchContext } = await import('../src/gateway/bindings.ts');
const { createProject, getProject, listProjects } = await import('../src/projects/manager.ts');
const { readVaultFile, appendDecision } = await import('../src/core/memory/vault.ts');
const { buildContext } = await import('../src/core/agent/context-builder.ts');
const { parseCron, cronMatches, nextRun } = await import('../src/scheduler/cron.ts');
const { createMagicLink, redeemMagicLink, isValidSession } = await import('../src/daemon/auth.ts');
await import('../src/core/tools/index.ts');
const { visibleTools, executeTool } = await import('../src/core/tools/registry.ts');
const { runAgent } = await import('../src/core/agent/loop.ts');

before(() => ensureHome());
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('config: defaults, set, secrets', () => {
  const config = loadConfig(true);
  assert.equal(config.daemon.port, 7460);
  setConfigValue('model.model', 'test-model');
  assert.equal(loadConfig(true).model.model, 'test-model');
  setSecret('TEST_KEY', 'sk-test-123456789');
  assert.equal(getSecret('TEST_KEY'), 'sk-test-123456789');
  assert.ok(!redactSecret('sk-test-123456789').includes('test-1234'));
});

test('sessions: create, append, read, search', () => {
  const session = createSession(null, 'test');
  appendMessage(session.id, { role: 'user', content: 'remember the zanzibar protocol' });
  appendMessage(session.id, { role: 'assistant', content: 'Noted: zanzibar protocol.' });
  const messages = getMessages(session.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, 'user');
  const hits = searchMessages('zanzibar', undefined);
  assert.ok(hits.length >= 1, `expected FTS/LIKE hits (fts=${hasFts()})`);
  assert.ok(listSessions(null).some((s) => s.id === session.id));
});

test('projects: create scaffolds vault; decisions append', () => {
  const project = createProject('Test Project', null);
  assert.equal(getProject(project.slug)?.name, 'Test Project');
  assert.match(readVaultFile(project.slug, 'BRIEF.md'), /Test Project/);
  appendDecision(project.slug, 'Use SQLite.');
  assert.match(readVaultFile(project.slug, 'DECISIONS.md'), /Use SQLite/);
  assert.equal(listProjects().some((p) => p.slug === project.slug), true);
});

test('bindings: main by default, switch to project', () => {
  const binding = resolveBinding('telegram', '12345');
  assert.equal(binding.projectSlug, null);
  const project = createProject('Bound Project', null);
  const switched = switchContext('telegram', '12345', project.slug);
  assert.equal(switched.projectSlug, project.slug);
  assert.equal(resolveBinding('telegram', '12345').projectSlug, project.slug);
  assert.notEqual(switched.sessionId, binding.sessionId);
});

test('context builder: includes vault, budgets history', () => {
  const project = createProject('Ctx Project', null);
  const history = Array.from({ length: 50 }, (_, i) => ({
    role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
    content: `message ${i} ` + 'x'.repeat(2000),
  }));
  const { system, messages } = buildContext(getProject(project.slug), history, 'test');
  assert.match(system, /Ctx Project/);
  assert.match(system, /context_pack/);
  assert.ok(messages.length < 50, 'history should be budget-clipped');
  assert.notEqual(messages[0]!.role, 'tool');
});

test('cron: parse, match, next', () => {
  const spec = parseCron('0 9 * * 1');
  assert.ok(cronMatches(spec, new Date('2026-06-15T09:00:00'))); // a Monday
  assert.ok(!cronMatches(spec, new Date('2026-06-16T09:00:00')));
  const next = nextRun('*/5 * * * *', new Date('2026-06-10T10:02:00'));
  assert.equal(next?.getMinutes(), 5);
  assert.throws(() => parseCron('bad cron'));
});

test('auth: magic link redeems once, session validates', () => {
  const token = createMagicLink();
  const session = redeemMagicLink(token);
  assert.ok(session);
  assert.equal(redeemMagicLink(token), null, 'magic link must be one-time');
  assert.ok(isValidSession(session));
  assert.ok(!isValidSession('forged-token'));
});

test('tools: registry filters toolsets; file tools respect project jail', async () => {
  const names = visibleTools().map((t) => t.name);
  assert.ok(names.includes('file_read'));
  assert.ok(names.includes('shell_run'));
  const filtered = visibleTools({ stripToolsets: ['shell'] }).map((t) => t.name);
  assert.ok(!filtered.includes('shell_run'));

  const ctx = {
    projectSlug: 'jail',
    sessionId: 'ses_test',
    channel: 'test',
    chatId: null,
    workingDir: home,
    emitLane: () => {},
    signal: new AbortController().signal,
  };
  const escape = await executeTool(
    { id: 't1', name: 'file_read', arguments: { path: '../../etc/passwd' } },
    ctx,
  );
  assert.ok(escape.isError, 'path escape must be rejected');
});

test('agent loop: mock provider chats and calls tools', async () => {
  setConfigValue('model.provider', 'mock');
  setConfigValue('model.model', 'mock-1');
  const session = createSession(null, 'test');

  // Plain chat
  let text = '';
  for await (const event of runAgent({
    sessionId: session.id,
    project: null,
    channel: 'test',
    userText: 'hello world',
  })) {
    if (event.type === 'text') text += event.delta;
  }
  assert.match(text, /hello world/);

  // Tool round-trip
  const session2 = createSession(null, 'test');
  const events: string[] = [];
  for await (const event of runAgent({
    sessionId: session2.id,
    project: null,
    channel: 'test',
    userText: ':tool list_dir {"path": "."}',
  })) {
    events.push(event.type);
  }
  assert.ok(events.includes('tool-start'));
  assert.ok(events.includes('tool-end'));
  assert.equal(events.at(-1), 'done');
  const persisted = getMessages(session2.id);
  assert.ok(persisted.some((m) => m.role === 'tool'), 'tool results persisted');
});
