import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  bearerFromHeader,
  generateDevToken,
  requestToken,
  resolveAuthToken,
  tokensMatch,
} from '../src/auth.ts';
import { type RunningHttpServer, startHttpServer } from '../src/http.ts';
import { AmritaKernel } from '../src/kernel.ts';

const TOKEN = 'test-token-abc123';

describe('auth helpers', () => {
  it('matches tokens in constant time and never throws on length mismatch', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, 'wrong')).toBe(false);
    expect(tokensMatch(TOKEN, `${TOKEN}x`)).toBe(false); // longer
    expect(tokensMatch(TOKEN, undefined)).toBe(false);
    expect(tokensMatch(TOKEN, null)).toBe(false);
    expect(tokensMatch('', 'anything')).toBe(true); // auth disabled
  });

  it('parses bearer headers and prefers header over query token', () => {
    expect(bearerFromHeader('Bearer abc')).toBe('abc');
    expect(bearerFromHeader('bearer abc')).toBe('abc');
    expect(bearerFromHeader('Basic abc')).toBeUndefined();
    expect(bearerFromHeader(undefined)).toBeUndefined();
    expect(requestToken('Bearer fromHeader', 'fromQuery')).toBe('fromHeader');
    expect(requestToken(undefined, 'fromQuery')).toBe('fromQuery');
    expect(requestToken(undefined, null)).toBeUndefined();
  });

  it('resolves env token first, else generates an ephemeral one', () => {
    expect(resolveAuthToken('env-token')).toEqual({ token: 'env-token', source: 'env' });
    expect(resolveAuthToken('  spaced  ')).toEqual({ token: 'spaced', source: 'env' });
    const gen = resolveAuthToken(undefined, () => 'GENERATED');
    expect(gen).toEqual({ token: 'GENERATED', source: 'generated' });
    expect(generateDevToken()).toMatch(/^[A-Za-z0-9_-]+$/); // url-safe, no padding
    expect(generateDevToken()).not.toBe(generateDevToken()); // fresh each call
  });
});

describe('http auth guard', () => {
  let kernel: AmritaKernel;
  let running: RunningHttpServer;
  let base: string;
  let wsBase: string;

  beforeEach(async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    running = await startHttpServer(kernel, { port: 0, authToken: TOKEN });
    base = `http://127.0.0.1:${running.port}`;
    wsBase = `ws://127.0.0.1:${running.port}`;
  });
  afterEach(async () => {
    await running.close();
    kernel.close();
  });

  const rpcBody = JSON.stringify({ id: 1, method: 'ping' });

  it('keeps GET /health public', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('rejects POST /rpc without a token', async () => {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpcBody,
    });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('rejects POST /rpc with a bad token', async () => {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
      body: rpcBody,
    });
    expect(r.status).toBe(401);
  });

  it('allows POST /rpc with the good token', async () => {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: rpcBody,
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as { result: { pong: boolean } }).toMatchObject({
      result: { pong: true },
    });
  });

  it('protects GET /events but not with a leaked token in the error', async () => {
    const unauth = await fetch(`${base}/events?conversationId=x`);
    expect(unauth.status).toBe(401);
    const ok = await fetch(`${base}/events?conversationId=x`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('allows a WS connection with a query token and rejects one without', async () => {
    const proj = await rpcAuthed('project.ensure', { slug: 'a', name: 'A' });
    const conv = await rpcAuthed('conversation.create', { projectId: proj.id });

    const good = new WebSocket(
      `${wsBase}/events/ws?conversationId=${conv.id}&token=${encodeURIComponent(TOKEN)}`,
    );
    const replayed = new Promise<boolean>((resolve, reject) => {
      good.on('message', (d: Buffer) => {
        if (JSON.parse(d.toString()).t === 'replayed') resolve(true);
      });
      good.on('error', reject);
    });
    expect(await replayed).toBe(true);
    good.close();

    const bad = new WebSocket(`${wsBase}/events/ws?conversationId=${conv.id}`);
    const closedOrErrored = new Promise<'closed'>((resolve) => {
      bad.on('error', () => resolve('closed'));
      bad.on('close', () => resolve('closed'));
    });
    expect(await closedOrErrored).toBe('closed');
  });

  async function rpcAuthed<T = { id: string }>(method: string, params?: unknown): Promise<T> {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: 1, method, params }),
    });
    return ((await r.json()) as { result: T }).result;
  }
});
