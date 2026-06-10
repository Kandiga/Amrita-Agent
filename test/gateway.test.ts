import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated state dir (each test file runs in its own process under node --test).
const home = mkdtempSync(join(tmpdir(), 'amrita-gw-'));
process.env.AMRITA_HOME = home;

const { ensureHome } = await import('../src/shared/paths.ts');
const { setConfigValue } = await import('../src/shared/config.ts');
const { closeDb } = await import('../src/core/store/db.ts');
const { createProject } = await import('../src/projects/manager.ts');
const { resolveBinding } = await import('../src/gateway/bindings.ts');
const { handleInbound } = await import('../src/gateway/gateway.ts');
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from '../src/shared/types.ts';

/** Fake adapter that records everything sent, so we can assert on UX. */
function fakeAdapter(buttons = true): ChannelAdapter & { sent: { chatId: string; msg: OutboundMessage }[] } {
  const sent: { chatId: string; msg: OutboundMessage }[] = [];
  return {
    name: 'test',
    capabilities: { buttons, streaming: false, lanes: false },
    sent,
    async start() {},
    async stop() {},
    async send(chatId: string, msg: OutboundMessage) {
      sent.push({ chatId, msg });
    },
  };
}

const inbound = (text: string, chatId = 'chat-1'): InboundMessage => ({
  channel: 'test',
  chatId,
  userId: 'u1',
  text,
});

before(() => {
  ensureHome();
  // Deterministic, offline brain for the agent path.
  setConfigValue('model.provider', 'mock');
  setConfigValue('model.model', 'mock-1');
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('gateway: /help explains Amrita and lists commands', async () => {
  const a = fakeAdapter();
  await handleInbound(a, inbound('/help'));
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0]!.msg.text, /Amrita/);
  assert.match(a.sent[0]!.msg.text, /\/projects/);
});

test('gateway: /projects with none nudges to create one', async () => {
  const a = fakeAdapter();
  await handleInbound(a, inbound('/projects', 'empty-chat'));
  assert.match(a.sent[0]!.msg.text, /No projects yet/);
  assert.equal(a.sent[0]!.msg.buttons, undefined);
});

test('gateway: /projects renders buttons including Main fallback', async () => {
  createProject('Gateway Proj', null);
  const a = fakeAdapter(true);
  await handleInbound(a, inbound('/projects'));
  const buttons = a.sent[0]!.msg.buttons!;
  assert.ok(buttons.length >= 2, 'a project row plus a Main row');
  const flat = buttons.flat();
  assert.ok(flat.some((b) => b.label.includes('Gateway Proj')));
  assert.ok(flat.some((b) => b.action === 'switch:'), 'Main Amrita button uses empty switch action');
});

test('gateway: switch + /where + /main move the binding', async () => {
  const project = createProject('Switch Target', null);
  const chatId = 'switch-chat';

  await handleInbound(fakeAdapter(), inbound(`switch:${project.slug}`, chatId));
  assert.equal(resolveBinding('test', chatId).projectSlug, project.slug);

  const whereAdapter = fakeAdapter();
  await handleInbound(whereAdapter, inbound('/where', chatId));
  assert.match(whereAdapter.sent[0]!.msg.text, /Switch Target/);

  await handleInbound(fakeAdapter(), inbound('/main', chatId));
  assert.equal(resolveBinding('test', chatId).projectSlug, null);
});

test('gateway: switching to an unknown project is rejected', async () => {
  const a = fakeAdapter();
  await handleInbound(a, inbound('switch:does-not-exist', 'unknown-chat'));
  assert.match(a.sent[0]!.msg.text, /Unknown project/);
  assert.equal(resolveBinding('test', 'unknown-chat').projectSlug, null);
});

test('gateway: /new starts a fresh session in the same context', async () => {
  const chatId = 'new-chat';
  const before = resolveBinding('test', chatId).sessionId;
  const a = fakeAdapter();
  await handleInbound(a, inbound('/new', chatId));
  const after = resolveBinding('test', chatId).sessionId;
  assert.notEqual(after, before);
  assert.match(a.sent[0]!.msg.text, /Fresh session/);
});

test('gateway: /stop with nothing running says so', async () => {
  const a = fakeAdapter();
  await handleInbound(a, inbound('/stop', 'idle-chat'));
  assert.match(a.sent[0]!.msg.text, /Nothing is running/);
});

test('gateway: a plain message runs the agent and replies', async () => {
  const a = fakeAdapter();
  await handleInbound(a, inbound('hello world', 'talk-main'));
  const all = a.sent.map((s) => s.msg.text).join('\n');
  assert.match(all, /You said: hello world/);
});

test('gateway: project-bound replies carry the context prefix', async () => {
  const project = createProject('Prefix Proj', null);
  const chatId = 'talk-proj';
  await handleInbound(fakeAdapter(), inbound(`switch:${project.slug}`, chatId));

  const a = fakeAdapter();
  await handleInbound(a, inbound('ping', chatId));
  const all = a.sent.map((s) => s.msg.text).join('\n');
  assert.match(all, /📁 Prefix Proj/);
});
