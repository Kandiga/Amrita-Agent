import { MIGRATIONS } from '@amrita/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  type RunningHttpServer,
  allowPublicHit,
  publicRateKey,
  startHttpServer,
} from '../src/http.ts';
import { AmritaKernel } from '../src/kernel.ts';

let kernel: AmritaKernel;
let running: RunningHttpServer;
let base: string;
let wsBase: string;

beforeEach(async () => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  running = await startHttpServer(kernel, { port: 0 });
  base = `http://127.0.0.1:${running.port}`;
  wsBase = `ws://127.0.0.1:${running.port}`;
});
afterEach(async () => {
  await running.close();
  kernel.close();
});

interface RpcOk<T> {
  result: T;
}
async function rpc<T = unknown>(method: string, params?: unknown): Promise<T> {
  const r = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, method, params }),
  });
  const body = (await r.json()) as RpcOk<T> & { error?: { code: string; message: string } };
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

describe('http control api', () => {
  it('GET /health returns kernel health', async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { ok: boolean; schemaVersion: number };
    expect(j.ok).toBe(true);
    expect(j.schemaVersion).toBe(MIGRATIONS.length - 1);
  });

  it('startHttpServer REJECTS on a taken port instead of throwing uncaught (ST1)', async () => {
    // The first server holds `running.port`. A second bind to it must reject the
    // promise (so the daemon can exit honestly), not crash with an uncaught error.
    const k2 = AmritaKernel.open({ dbPath: ':memory:' });
    await expect(startHttpServer(k2, { port: running.port })).rejects.toMatchObject({
      code: 'EADDRINUSE',
    });
    k2.close();
  });

  it('POST /rpc runs a chat turn (mock provider)', async () => {
    const proj = await rpc<{ id: string }>('project.ensure', { slug: 'crm', name: 'CRM' });
    const conv = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });
    const turn = await rpc<{ provider: string; text: string }>('chat.turn', {
      conversationId: conv.id,
      text: 'hello over http',
    });
    expect(turn.provider).toBe('mock');
    expect(turn.text).toContain('hello over http');
  });

  it('GET /events replays persisted events with sinceSeq', async () => {
    const proj = await rpc<{ id: string }>('project.ensure', { slug: 'd', name: 'D' });
    const conv = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });
    await rpc('chat.turn', { conversationId: conv.id, text: 'hi' });

    const all = await (await fetch(`${base}/events?conversationId=${conv.id}`)).json();
    expect((all as { events: unknown[] }).events.length).toBe(7); // full turn sequence
    const since = await (await fetch(`${base}/events?conversationId=${conv.id}&sinceSeq=1`)).json();
    expect((since as { events: { seq: number }[] }).events[0]?.seq).toBe(2);
    // missing conversationId → 400
    expect((await fetch(`${base}/events`)).status).toBe(400);
  });

  it('returns safe structured errors for bad RPC and unknown routes', async () => {
    const r = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'nope' }),
    });
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unknown_method');

    const badJson = await fetch(`${base}/rpc`, { method: 'POST', body: 'not json' });
    expect(badJson.status).toBe(400);

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('websocket event stream', () => {
  function onceOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
  }

  it('replays then live-streams events for a conversation (no secrets)', async () => {
    const proj = await rpc<{ id: string }>('project.ensure', { slug: 'w', name: 'W' });
    const conv = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });
    await rpc('chat.turn', { conversationId: conv.id, text: 'first' });

    const ws = new WebSocket(`${wsBase}/events/ws?conversationId=${conv.id}`);
    const frames: { t: string; event?: { type: string; payload?: { text?: string } } }[] = [];

    const replayed = new Promise<void>((resolve) => {
      ws.on('message', (d: Buffer) => {
        const f = JSON.parse(d.toString());
        frames.push(f);
        if (f.t === 'replayed') resolve();
      });
    });
    await onceOpen(ws);
    await replayed;
    // replay included the first user message
    expect(frames.some((f) => f.t === 'event' && f.event?.payload?.text === 'first')).toBe(true);

    // live: a turn started after connect is fanned out
    const liveSecond = new Promise<{ payload?: { text?: string } }>((resolve) => {
      ws.on('message', (d: Buffer) => {
        const f = JSON.parse(d.toString());
        if (
          f.t === 'event' &&
          f.event?.type === 'message.user' &&
          f.event.payload?.text === 'second'
        ) {
          resolve(f.event);
        }
      });
    });
    await rpc('chat.turn', { conversationId: conv.id, text: 'second' });
    const live = await liveSecond;
    expect(live.payload?.text).toBe('second');

    expect(JSON.stringify(frames)).not.toMatch(/sk-|password|secret_value/i);
    ws.close();
  });

  it('close() resolves promptly even with a live client connected (no 90s stop-hang)', async () => {
    // Regression: server.close() fires only once every connection is gone, and a
    // persistent /events/ws socket never closes itself — so without terminating
    // clients, close() would hang until systemd SIGKILLs the daemon at 90s.
    const k2 = AmritaKernel.open({ dbPath: ':memory:' });
    const srv = await startHttpServer(k2, { port: 0 });
    const proj = await fetch(`http://127.0.0.1:${srv.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, method: 'project.ensure', params: { slug: 'z', name: 'Z' } }),
    }).then((r) => r.json() as Promise<{ result: { id: string } }>);
    const conv = await fetch(`http://127.0.0.1:${srv.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        method: 'conversation.create',
        params: { projectId: proj.result.id },
      }),
    }).then((r) => r.json() as Promise<{ result: { id: string } }>);

    const ws = new WebSocket(
      `ws://127.0.0.1:${srv.port}/events/ws?conversationId=${conv.result.id}`,
    );
    await onceOpen(ws);

    // With a client still connected, close() must still settle quickly.
    const closed = srv.close();
    const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000));
    expect(await Promise.race([closed.then(() => 'closed'), timeout])).toBe('closed');
    k2.close();
  });

  // ADR-0044: the board is worthless if a drag in one tab never reaches the other.
  it('fans out a PROJECT change made in another conversation', async () => {
    const proj = await rpc<{ id: string }>('project.ensure', { slug: 'board', name: 'Board' });
    // The socket watches conversation A…
    const a = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });
    // …but the task is created and dragged from conversation B (a second tab, the
    // CLI, Telegram — anything).
    const b = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });

    const ws = new WebSocket(`${wsBase}/events/ws?conversationId=${a.id}&projectId=${proj.id}`);
    const projectFrames: { type: string }[] = [];
    const gotUpdate = new Promise<void>((resolve) => {
      ws.on('message', (d: Buffer) => {
        const f = JSON.parse(d.toString()) as { t: string; event?: { type: string } };
        if (f.t === 'project-event' && f.event) {
          projectFrames.push(f.event);
          if (f.event.type === 'task.updated') resolve();
        }
      });
    });
    await onceOpen(ws);

    const t = await rpc<{ taskId: string }>('tasks.create', {
      projectId: proj.id,
      conversationId: b.id,
      title: 'File the permit',
    });
    await rpc('tasks.update', {
      projectId: proj.id,
      conversationId: b.id,
      taskId: t.taskId,
      status: 'later',
      orderKey: 'an',
    });

    await gotUpdate;
    expect(projectFrames.map((e) => e.type)).toEqual(['task.created', 'task.updated']);
    ws.close();
  });

  it('sends NO project frames when the socket did not ask for a project', async () => {
    const proj = await rpc<{ id: string }>('project.ensure', { slug: 'quiet', name: 'Quiet' });
    const a = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });
    const b = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });

    const ws = new WebSocket(`${wsBase}/events/ws?conversationId=${a.id}`); // no projectId
    const frames: string[] = [];
    ws.on('message', (d: Buffer) => frames.push((JSON.parse(d.toString()) as { t: string }).t));
    await onceOpen(ws);

    await rpc('tasks.create', { projectId: proj.id, conversationId: b.id, title: 'x' });
    await new Promise((r) => setTimeout(r, 120));

    expect(frames).not.toContain('project-event'); // opt-in, not a firehose
    ws.close();
  });

  it('forwards stream-only model.delta frames that concatenate to the agent reply', async () => {
    const proj = await rpc<{ id: string }>('project.ensure', { slug: 's', name: 'S' });
    const conv = await rpc<{ id: string }>('conversation.create', { projectId: proj.id });

    const ws = new WebSocket(`${wsBase}/events/ws?conversationId=${conv.id}`);
    const deltas: string[] = [];
    let agentText = '';
    const agentArrived = new Promise<void>((resolve) => {
      ws.on('message', (d: Buffer) => {
        const f = JSON.parse(d.toString()) as {
          t: string;
          event?: { type: string; seq: number; payload?: { text?: string } };
        };
        if (f.t !== 'event' || !f.event) return;
        if (f.event.type === 'model.delta') {
          expect(f.event.seq).toBe(0); // stream-only: never store-sealed
          deltas.push(f.event.payload?.text ?? '');
        }
        if (f.event.type === 'message.agent') {
          agentText = f.event.payload?.text ?? '';
          resolve();
        }
      });
    });
    await onceOpen(ws);
    await rpc('chat.turn', { conversationId: conv.id, text: 'stream over the socket' });
    await agentArrived;

    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(agentText);
    // the replay path never returns deltas — they are ephemeral
    const replay = (await (await fetch(`${base}/events?conversationId=${conv.id}`)).json()) as {
      events: { type: string }[];
    };
    expect(replay.events.some((e) => e.type === 'model.delta')).toBe(false);
    ws.close();
  });

  it('rejects a WS connection with no conversationId', async () => {
    const ws = new WebSocket(`${wsBase}/events/ws`);
    const closed = new Promise<number>((resolve) => {
      ws.on('close', (code: number) => resolve(code));
    });
    expect(await closed).toBe(1008);
  });
});

describe('the public-hub rate limiter keys on the real visitor, not the proxy (ADR-0045)', () => {
  const socket = (peer: string) => ({ socket: { remoteAddress: peer }, headers: {} }) as never;
  const behindProxy = (peer: string, xff: string) =>
    ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': xff } }) as never;

  it('trusts X-Forwarded-For ONLY from a loopback peer (our own proxy)', () => {
    // Behind the bundled proxy, the peer is loopback and the visitor is in XFF.
    expect(publicRateKey(behindProxy('127.0.0.1', '203.0.113.9'))).toBe('203.0.113.9');
    // A direct, non-loopback peer's XFF is a lie we refuse to believe.
    expect(publicRateKey(behindProxy('203.0.113.9', '10.0.0.1'))).toBe('203.0.113.9');
  });

  it('takes the RIGHTMOST hop — a client cannot spoof by pre-seeding the header', () => {
    // The proxy appends the true peer last; a client-supplied left value is ignored.
    expect(publicRateKey(behindProxy('127.0.0.1', '1.1.1.1, 203.0.113.9'))).toBe('203.0.113.9');
  });

  it('two different visitors through the proxy do NOT share one bucket', () => {
    const now = 1_000_000;
    const a = publicRateKey(behindProxy('127.0.0.1', '198.51.100.1'));
    const b = publicRateKey(behindProxy('127.0.0.1', '198.51.100.2'));
    // Exhaust visitor A completely…
    let lastA = true;
    for (let i = 0; i < 100; i++) lastA = allowPublicHit(a, now);
    expect(lastA).toBe(false);
    // …visitor B is untouched. The old code keyed both on 127.0.0.1 and B would 429.
    expect(allowPublicHit(b, now)).toBe(true);
  });

  it('falls back to the socket peer when there is no proxy header', () => {
    expect(publicRateKey(socket('203.0.113.42'))).toBe('203.0.113.42');
  });
});
