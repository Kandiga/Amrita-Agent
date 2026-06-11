import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningHttpServer, startHttpServer } from '../src/http.ts';
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
    expect(j.schemaVersion).toBe(6);
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
