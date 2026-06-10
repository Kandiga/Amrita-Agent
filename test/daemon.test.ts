import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const home = mkdtempSync(join(tmpdir(), 'amrita-daemon-'));
process.env.AMRITA_HOME = home;

const { ensureHome } = await import('../src/shared/paths.ts');
const { loadConfig } = await import('../src/shared/config.ts');
const { closeDb } = await import('../src/core/store/db.ts');
const { createDaemonServer } = await import('../src/daemon/server.ts');
const { createMagicLink, redeemMagicLink } = await import('../src/daemon/auth.ts');

let server: Server;
let base = '';
let cookie = '';

before(async () => {
  ensureHome();
  server = createDaemonServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A real session, the same way the browser obtains one.
  const session = redeemMagicLink(createMagicLink());
  cookie = `amrita_session=${session}`;
});

after(() => {
  server.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const get = (path: string, withCookie = true) =>
  fetch(base + path, { headers: withCookie ? { cookie } : {} });
const post = (path: string, body: unknown, withCookie = true) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

test('daemon: /healthz is public', async () => {
  const res = await get('/healthz', false);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, name: 'amrita' });
});

test('daemon: API requires a session', async () => {
  const res = await get('/api/state', false);
  assert.equal(res.status, 401);
});

test('daemon: an invalid magic link does not authenticate', async () => {
  assert.equal(redeemMagicLink('forged-token'), null);
});

test('daemon: /api/state returns shape for an authed session', async () => {
  const res = await get('/api/state');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { projects: unknown[]; model: unknown; channels: unknown };
  assert.ok(Array.isArray(body.projects));
  assert.ok(body.model);
  assert.ok(body.channels);
});

test('daemon: settings POST whitelists keys', async () => {
  const bad = await post('/api/settings', { key: 'daemon.port', value: 9999 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json() as { error: string }).error, /not allowed/);

  const good = await post('/api/settings', { key: 'model.model', value: 'claude-opus-4-8' });
  assert.equal(good.status, 200);
  assert.equal(loadConfig(true).model.model, 'claude-opus-4-8');
});

test('daemon: secret POST whitelists names and rejects empties', async () => {
  const unknown = await post('/api/secret', { name: 'AWS_SECRET', value: 'x' });
  assert.equal(unknown.status, 400);

  const empty = await post('/api/secret', { name: 'ANTHROPIC_API_KEY', value: '' });
  assert.equal(empty.status, 400);

  const ok = await post('/api/secret', { name: 'ANTHROPIC_API_KEY', value: 'test-anthropic-key' });
  assert.equal(ok.status, 200);
});

test('daemon: project creation validates input', async () => {
  const missing = await post('/api/project/new', {});
  assert.equal(missing.status, 400);

  const created = await post('/api/project/new', { name: 'Daemon Project' });
  assert.equal(created.status, 200);
  const body = (await created.json()) as { project: { name: string; slug: string } };
  assert.equal(body.project.name, 'Daemon Project');
  assert.ok(body.project.slug);
});

test('daemon: settings GET reports honest provider state', async () => {
  const res = await get('/api/settings');
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    providers: { id: string; state: string }[];
    telegram: { state: string };
  };
  assert.ok(body.providers.length > 0);
  // We just set ANTHROPIC_API_KEY above; it should read as configured.
  const anthropic = body.providers.find((p) => p.id === 'anthropic');
  assert.ok(anthropic, 'anthropic profile present');
  assert.equal(anthropic!.state, 'configured');
  assert.equal(body.telegram.state, 'needs-setup');
});
