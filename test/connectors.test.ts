import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const home = mkdtempSync(join(tmpdir(), 'amrita-conn-'));
process.env.AMRITA_HOME = home;

const { ensureHome } = await import('../src/shared/paths.ts');
const { setConfigValue } = await import('../src/shared/config.ts');
const { closeDb } = await import('../src/core/store/db.ts');
await import('../src/connectors/index.ts');
const { executeTool } = await import('../src/core/tools/registry.ts');
import type { LaneEvent, ToolContext } from '../src/shared/types.ts';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    projectSlug: null,
    sessionId: 'ses_conn',
    channel: 'test',
    chatId: null,
    workingDir: null,
    emitLane: () => {},
    signal: new AbortController().signal,
    ...over,
  };
}

const run = (name: string, args: Record<string, unknown>, c = ctx()) =>
  executeTool({ id: 't', name, arguments: args }, c);

// A stand-in Open Design daemon.
let odServer: Server;
let odUrl = '';

before(async () => {
  ensureHome();
  odServer = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/api/projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'p1', name: 'Demo Project' }]));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  odServer.listen(0, '127.0.0.1');
  await once(odServer, 'listening');
  odUrl = `http://127.0.0.1:${(odServer.address() as AddressInfo).port}`;
});

after(() => {
  odServer.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('open-design: disabled connector returns an honest message', async () => {
  setConfigValue('connectors.openDesign.enabled', false);
  const result = await run('open_design_status', {});
  assert.match(result.content, /disabled/i);
  assert.ok(!result.isError);
});

test('open-design: reports up and lists projects when reachable', async () => {
  setConfigValue('connectors.openDesign.enabled', true);
  setConfigValue('connectors.openDesign.baseUrl', odUrl);
  const result = await run('open_design_status', {});
  assert.match(result.content, /Open Design is up/);
  assert.match(result.content, /Demo Project/);
});

test('open-design: unreachable daemon degrades, never throws', async () => {
  setConfigValue('connectors.openDesign.enabled', true);
  // An almost-certainly-dead port.
  setConfigValue('connectors.openDesign.baseUrl', 'http://127.0.0.1:1');
  const result = await run('open_design_status', {});
  assert.match(result.content, /not reachable/);
  assert.ok(!result.isError, 'connector failures are surfaced as text, not tool errors');
});

test('open-design: a run opens then closes a preview lane', async () => {
  setConfigValue('connectors.openDesign.enabled', true);
  setConfigValue('connectors.openDesign.baseUrl', 'http://127.0.0.1:1'); // POST fails → graceful
  const lanes: LaneEvent[] = [];
  const result = await run('open_design_run', { projectId: 'p1', brief: 'a card' }, ctx({ emitLane: (e) => lanes.push(e) }));
  assert.ok(lanes.some((l) => l.kind === 'open' && l.lane === 'preview'));
  assert.ok(lanes.some((l) => l.kind === 'close'));
  assert.match(result.content, /Open Design/);
});

test('claude-code: disabled connector is reported, not launched', async () => {
  setConfigValue('connectors.claudeCode.enabled', false);
  const result = await run('claude_code_run', { task: 'do a thing' });
  assert.match(result.content, /disabled/i);
});

test('claude-code: refuses to launch without a working directory', async () => {
  setConfigValue('connectors.claudeCode.enabled', true);
  const result = await run('claude_code_run', { task: 'do a thing' }, ctx({ workingDir: null }));
  assert.match(result.content, /working directory/i);
});
