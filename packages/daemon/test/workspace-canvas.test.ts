import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLaneRunner } from '@amrita/lanes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningHttpServer, startHttpServer } from '../src/http.ts';
import { AmritaKernel } from '../src/kernel.ts';

/** ADR-0039: default lane workspaces + the read-only workspace file endpoint. */

let kernel: AmritaKernel;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'amrita-ws-'));
});
afterEach(() => {
  kernel.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seed(): { conversationId: string } {
  const p = kernel.ensureProject({ slug: 'ws', name: 'WS' });
  const c = kernel.createConversation({ projectId: p.id });
  return { conversationId: c.id };
}

describe('default lane workspace (ADR-0039)', () => {
  it('a real run without paths gets <root>/<laneId>, created and sealed into the mandate', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneAllowedRoots: [tmp],
      laneRunner: new FakeLaneRunner({ summary: 'built' }),
    });
    const { conversationId } = seed();
    const res = await kernel.startLane({
      conversationId,
      goal: 'build a landing page',
      approvals: 'auto-safe', // skip the operator gate in tests
    });
    expect(res.status).toBe('completed');
    const lane = kernel.getLane(res.laneId);
    const paths = (JSON.parse(lane?.mandateJson ?? '{}') as { scope: { paths?: string[] } }).scope
      .paths;
    expect(paths).toEqual([join(tmp, res.laneId)]);
    expect(existsSync(join(tmp, res.laneId))).toBe(true);
  });

  it('dry runs and explicit paths are untouched', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneAllowedRoots: [tmp],
      laneRunner: new FakeLaneRunner({}),
    });
    const { conversationId } = seed();
    const dry = await kernel.startLane({ conversationId, goal: 'plan only', dryRun: true });
    const dryPaths = (
      JSON.parse(kernel.getLane(dry.laneId)?.mandateJson ?? '{}') as {
        scope: { paths?: string[] };
      }
    ).scope.paths;
    expect(dryPaths ?? []).toEqual([]);

    const explicit = join(tmp, 'chosen');
    mkdirSync(explicit);
    const real = await kernel.startLane({
      conversationId,
      goal: 'work here',
      approvals: 'auto-safe',
      scope: { paths: [explicit] },
    });
    const realPaths = (
      JSON.parse(kernel.getLane(real.laneId)?.mandateJson ?? '{}') as {
        scope: { paths?: string[] };
      }
    ).scope.paths;
    expect(realPaths).toEqual([explicit]);
  });
});

describe('GET /lanes/:id/workspace (ADR-0039)', () => {
  let running: RunningHttpServer;
  let base: string;
  let laneId: string;
  let workspace: string;

  beforeEach(async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneAllowedRoots: [tmp],
      laneRunner: new FakeLaneRunner({ summary: 'built' }),
    });
    const { conversationId } = seed();
    const res = await kernel.startLane({
      conversationId,
      goal: 'build it',
      approvals: 'auto-safe',
    });
    laneId = res.laneId;
    workspace = join(tmp, laneId);
    writeFileSync(join(workspace, 'index.html'), '<h1>the built page</h1>');
    mkdirSync(join(workspace, 'sub'));
    writeFileSync(join(workspace, 'sub', 'style.css'), 'body{color:red}');
    writeFileSync(join(tmp, 'outside.txt'), 'SECRET');
    symlinkSync(join(tmp, 'outside.txt'), join(workspace, 'leak.txt'));

    running = await startHttpServer(kernel, { port: 0, authToken: 'ws-token' });
    base = `http://127.0.0.1:${running.port}`;
  });
  afterEach(async () => {
    await running.close();
  });

  const get = (path: string, token = 'ws-token') =>
    fetch(`${base}${path}${path.includes('?') ? '&' : '?'}token=${token}`);

  it('serves index.html at the root and nested files with content types', async () => {
    const root = await get(`/lanes/${laneId}/workspace/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('the built page');

    const css = await get(`/lanes/${laneId}/workspace/sub/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses traversal, symlink escapes, missing files, unknown lanes, bad tokens', async () => {
    // dot-segment traversal is neutralized by URL normalization before routing
    const esc = await get(`/lanes/${laneId}/workspace/%2e%2e/outside.txt`);
    expect([403, 404]).toContain(esc.status);
    expect(await esc.text()).not.toContain('SECRET');

    // an encoded absolute path survives decoding — the confinement check 403s it
    const abs = await get(`/lanes/${laneId}/workspace/%2Fetc%2Fpasswd`);
    expect(abs.status).toBe(403);

    const leak = await get(`/lanes/${laneId}/workspace/leak.txt`);
    expect(leak.status).toBe(404); // symlink out of the root is refused

    expect((await get(`/lanes/${laneId}/workspace/missing.js`)).status).toBe(404);
    expect((await get('/lanes/01UNKNOWN/workspace/')).status).toBe(404);
    expect((await get(`/lanes/${laneId}/workspace/`, 'wrong')).status).toBe(401);
  });

  it('a workspace without index.html gets an honest listing', async () => {
    rmSync(join(workspace, 'index.html'));
    const r = await get(`/lanes/${laneId}/workspace/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('sub/');
    expect(html).toContain('No index.html yet');
  });
});
