import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningHttpServer, startHttpServer } from '../src/http.ts';
import { AmritaKernel } from '../src/kernel.ts';

/**
 * ADR-0057: the browser never holds the bearer. Pairing code → HttpOnly cookie
 * session; public /health is minimal; cookie-authed mutations need JSON.
 * Each test isolates its /pair rate-limit bucket with a distinct
 * x-forwarded-for (the daemon honors the rightmost hop from a loopback peer).
 */

const TOKEN = 'test-bearer-for-adr-0057';

let kernel: AmritaKernel;
let running: RunningHttpServer;
let base: string;

beforeEach(async () => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  running = await startHttpServer(kernel, { port: 0, authToken: TOKEN });
  base = `http://127.0.0.1:${running.port}`;
});
afterEach(async () => {
  await running.close();
  kernel.close();
});

/** Mint a pairing code the way the CLI does: bearer-gated RPC. */
async function mintCode(): Promise<string> {
  const r = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ id: 1, method: 'auth.pair.mint' }),
  });
  const body = (await r.json()) as { result: { code: string; expiresAt: string } };
  expect(body.result.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  return body.result.code;
}

/** Pair with a code from a given rate bucket; returns the session cookie or null. */
async function pair(code: string, bucket: string): Promise<string | null> {
  const r = await fetch(`${base}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': bucket },
    body: JSON.stringify({ code }),
  });
  if (r.status !== 204) return null;
  const setCookie = r.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('amrita_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  const m = /amrita_session=([^;]+)/.exec(setCookie);
  return m ? `amrita_session=${m[1]}` : null;
}

describe('public /health is minimal; authenticated /health is full (ADR-0057)', () => {
  it('a stranger learns ok:true and nothing else', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j).toEqual({ ok: true, name: 'amritad' }); // no dbPath/counts/lanes
  });

  it('the bearer sees the full payload', async () => {
    const r = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const j = (await r.json()) as { dbPath?: string; counts?: unknown };
    expect(typeof j.dbPath).toBe('string');
    expect(j.counts).toBeDefined();
  });

  it('security headers ride every response', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });

  it('serve-web mirrors the daemon SECURITY_HEADERS authority (no drift)', async () => {
    // The static server cannot import TS, so it mirrors the literals; this
    // fitness check fails the moment the two copies diverge.
    const { readFile } = await import('node:fs/promises');
    const { SECURITY_HEADERS } = await import('../src/http.ts');
    const mjs = await readFile(new URL('../../../deploy/serve-web.mjs', import.meta.url), 'utf8');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(mjs, `serve-web.mjs missing header ${name}`).toContain(`'${name}'`);
      for (const piece of value.split('; ')) {
        expect(mjs, `serve-web.mjs CSP/value drift on: ${piece}`).toContain(piece);
      }
    }
    // The E3 smoke once failed because /pair and /session fell through to the
    // SPA fallback: the browser's auth bootstrap MUST be proxied to the daemon.
    expect(mjs).toContain("'/pair'");
    expect(mjs).toContain("'/session'");
  });
});

describe('pairing → HttpOnly cookie session (ADR-0057)', () => {
  it('a minted code pairs exactly once; replay dies', async () => {
    const code = await mintCode();
    const cookie = await pair(code, '10.9.0.1');
    expect(cookie).not.toBeNull();
    expect(await pair(code, '10.9.0.2')).toBeNull(); // single-use
  });

  it('a garbage code never pairs', async () => {
    expect(await pair('AAAA-AAAA', '10.9.0.3')).toBeNull();
  });

  it('the cookie authenticates RPC and /session; logout kills it', async () => {
    const cookie = (await pair(await mintCode(), '10.9.0.4')) as string;

    // RPC with cookie only (no bearer), from the trusted (self) origin — the
    // faithful browser simulation: a real browser sends Origin on a POST.
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: base },
      body: JSON.stringify({ id: 1, method: 'health' }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { ok: boolean } };
    expect(body.result.ok).toBe(true);

    // /session probe:
    expect((await fetch(`${base}/session`, { headers: { cookie } })).status).toBe(204);
    expect((await fetch(`${base}/session`)).status).toBe(401);

    // logout → the same cookie is dead:
    const out = await fetch(`${base}/session/logout`, { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await fetch(`${base}/session`, { headers: { cookie } })).status).toBe(401);
  });

  it('a cookie-authed mutation must be JSON (CSRF floor); bearer is exempt', async () => {
    const cookie = (await pair(await mintCode(), '10.9.0.5')) as string;
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', cookie, origin: base },
      body: JSON.stringify({ id: 1, method: 'health' }),
    });
    expect(r.status).toBe(401); // a cross-site form could produce this shape

    const withBearer = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 1, method: 'health' }),
    });
    expect(withBearer.status).not.toBe(401); // header auth cannot be forged by a form
  });

  it('RED (finding 1): a cookie mutation from a HOSTILE same-site port is rejected', async () => {
    const cookie = (await pair(await mintCode(), '10.9.0.51')) as string;
    // A page on http://localhost:9999 is same-SITE (shared eTLD+1 "localhost")
    // so the cookie rides — but it is a different ORIGIN. A real browser stamps
    // that origin onto the request; the daemon must refuse to honor the cookie.
    const hostile = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'http://localhost:9999' },
      body: JSON.stringify({ id: 1, method: 'project.ensure', params: { slug: 'x', name: 'X' } }),
    });
    expect(hostile.status).toBe(401);
    // and a cookie mutation with NO Origin at all (anomalous for a browser POST):
    const noOrigin = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ id: 1, method: 'project.ensure', params: { slug: 'y', name: 'Y' } }),
    });
    expect(noOrigin.status).toBe(401);
    // the bearer is unaffected — no Origin, still fine (CLI client):
    const bearer = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 1, method: 'health' }),
    });
    expect(bearer.status).toBe(200);
  });

  it('no auth at all → RPC 401 (unchanged posture)', async () => {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'health' }),
    });
    expect(r.status).toBe(401);
  });

  /** Open a cookie-authenticated WS with an explicit Origin; resolve open/refused. */
  async function wsOpens(cookie: string, origin: string | undefined): Promise<boolean> {
    const headers: Record<string, string> = { cookie };
    if (origin) headers.origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${running.port}/events/ws?conversationId=nope`, {
      headers,
    });
    const ok = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    if (ok) ws.close();
    return ok;
  }

  it('the session cookie authenticates a WebSocket upgrade from the trusted origin', async () => {
    const cookie = (await pair(await mintCode(), '10.9.0.6')) as string;
    expect(await wsOpens(cookie, base)).toBe(true); // trusted (self) origin
  });

  it('RED (finding 1): a cookie WS from a HOSTILE origin is rejected before upgrade', async () => {
    const cookie = (await pair(await mintCode(), '10.9.0.61')) as string;
    // The core live hole: WS has no CORS/preflight, so only an explicit Origin
    // check stops a same-site page on another port from hijacking the socket.
    expect(await wsOpens(cookie, 'http://localhost:9999')).toBe(false);
    // and a cookie WS with NO Origin (browsers ALWAYS send Origin on WS) → refuse
    expect(await wsOpens(cookie, undefined)).toBe(false);
  });

  it('a bearer WebSocket needs no Origin (CLI client is preserved)', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${running.port}/events/ws?conversationId=nope&token=${TOKEN}`,
    );
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      ws.on('unexpected-response', () => resolve(false));
    });
    expect(opened).toBe(true);
    ws.close();
  });

  it('brute force hits the rate limit: 6th attempt in a window → 429', async () => {
    const bucket = '10.9.0.77';
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': bucket },
        body: JSON.stringify({ code: 'ZZZZ-ZZZZ' }),
      });
      expect(r.status).toBe(401);
    }
    const sixth = await fetch(`${base}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': bucket },
      body: JSON.stringify({ code: 'ZZZZ-ZZZZ' }),
    });
    expect(sixth.status).toBe(429);
  });
});
