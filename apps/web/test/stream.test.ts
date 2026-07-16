import { newId } from '@amrita/protocol';
import { describe, expect, it } from 'vitest';
import type { AmritaEventLite } from '../src/api.ts';
import {
  type EventStreamHandle,
  type StreamState,
  type WebSocketLike,
  openEventStream,
  toWsBase,
} from '../src/stream.ts';

/** A contract-valid sealed event (ADR-0032: invalid frames are dropped). */
function sealedEvent(seq: number, text: string) {
  return {
    id: newId(),
    seq,
    ts: '2026-07-11T10:00:00.000Z',
    projectId: newId(),
    conversationId: newId(),
    origin: 'user',
    type: 'message.user',
    payload: { text },
  };
}

function paneEvent(text: string) {
  const laneId = newId();
  return {
    id: newId(),
    seq: 0,
    ts: '2026-07-11T10:00:00.000Z',
    projectId: newId(),
    conversationId: newId(),
    laneId,
    origin: 'lane',
    type: 'lane.pane',
    payload: { laneId, text, state: 'running' },
  };
}

/** A controllable fake socket: tests drive open/message/close by hand. */
class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  open(): void {
    this.onopen?.();
  }
  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  fail(): void {
    this.onclose?.();
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

interface Harness {
  handle: EventStreamHandle;
  sockets: FakeSocket[];
  events: AmritaEventLite[];
  projectSessionEvents: AmritaEventLite[];
  states: StreamState[];
  replays: number[];
  runPending(): void;
}

function harness(opts: { maxRetries?: number } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const events: AmritaEventLite[] = [];
  const projectSessionEvents: AmritaEventLite[] = [];
  const states: StreamState[] = [];
  const replays: number[] = [];
  let pending: (() => void) | null = null;

  const handle = openEventStream(
    'c1',
    {
      onEvent: (e) => events.push(e),
      onProjectSessionEvent: (e) => projectSessionEvents.push(e),
      onState: (s) => states.push(s),
      onReplayed: (n) => replays.push(n),
    },
    {
      baseUrl: 'http://127.0.0.1:7460',
      webSocketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      backoffMs: [10],
      maxRetries: opts.maxRetries ?? 6,
      setTimeoutImpl: (fn) => {
        pending = fn;
        return 1;
      },
      clearTimeoutImpl: () => {
        pending = null;
      },
    },
  );

  return {
    handle,
    sockets,
    events,
    projectSessionEvents,
    states,
    replays,
    runPending: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

describe('event stream client', () => {
  it('derives a ws/wss origin from an http(s) base url', () => {
    expect(toWsBase('http://127.0.0.1:7460')).toBe('ws://127.0.0.1:7460');
    expect(toWsBase('https://amrita.example')).toBe('wss://amrita.example');
  });

  it('connects with the conversation id and sinceSeq, and reports open state', () => {
    const h = harness();
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]?.url).toContain('/events/ws?conversationId=c1&sinceSeq=0');
    h.sockets[0]?.open();
    expect(h.states).toContain('open');
    expect(h.handle.state()).toBe('open');
  });

  it('delivers event frames and drops malformed or contract-violating frames', () => {
    const h = harness();
    h.sockets[0]?.open();
    h.sockets[0]?.emit('}{ not json');
    // a frame that fails the protocol parse is dropped (ADR-0032)
    h.sockets[0]?.emit({
      t: 'event',
      event: { id: 'e1', seq: 3, ts: 't', type: 'message.user', payload: { text: 'nope' } },
    });
    const ev = sealedEvent(3, 'hi');
    h.sockets[0]?.emit({ t: 'event', event: ev });
    h.sockets[0]?.emit({ t: 'replayed', conversationId: ev.conversationId, sinceSeq: 3 });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.id).toBe(ev.id);
    expect(h.replays).toEqual([3]);
  });

  it('delivers only lane.pane project-session frames and does not advance the chat cursor', () => {
    const h = harness();
    h.sockets[0]?.open();
    const pane = paneEvent('screen from another conversation');
    h.sockets[0]?.emit({ t: 'project-session-event', event: pane });
    // Defense in depth: even a contract-valid non-pane event on this frame is dropped.
    h.sockets[0]?.emit({ t: 'project-session-event', event: sealedEvent(99, 'private') });

    expect(h.projectSessionEvents.map((event) => event.id)).toEqual([pane.id]);
    expect(h.events).toHaveLength(0);
    h.sockets[0]?.fail();
    h.runPending();
    expect(h.sockets[1]?.url).toContain('sinceSeq=0');
  });

  it('reconnects with backoff after a drop and resumes from the last seq', () => {
    const h = harness();
    h.sockets[0]?.open();
    h.sockets[0]?.emit({ t: 'event', event: sealedEvent(7, 'a') });
    h.sockets[0]?.fail(); // connection dropped
    expect(h.handle.state()).toBe('reconnecting');
    h.runPending(); // backoff timer fires
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.url).toContain('sinceSeq=7'); // resumes after the last event
  });

  it('gives up with state "error" after exhausting retries', () => {
    const h = harness({ maxRetries: 1 });
    h.sockets[0]?.fail(); // attempt 1 fails → schedule retry (retries=1)
    h.runPending();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]?.fail(); // retries already at max → give up
    expect(h.handle.state()).toBe('error');
  });

  it('ignores late open/message callbacks from a closed or superseded socket', () => {
    const h = harness();
    const old = h.sockets[0] as FakeSocket;
    old.fail();
    h.runPending();
    const current = h.sockets[1] as FakeSocket;
    current.open();

    old.open();
    old.emit({ t: 'event', event: sealedEvent(4, 'stale') });
    expect(h.events).toHaveLength(0);
    expect(h.handle.state()).toBe('open');

    h.handle.close();
    current.emit({ t: 'event', event: sealedEvent(5, 'after close') });
    expect(h.events).toHaveLength(0);
    expect(h.handle.state()).toBe('closed');
  });

  it('appends an encoded token to the ws url when provided', () => {
    const urls: string[] = [];
    const handle = openEventStream(
      'c1',
      { onEvent: () => {} },
      {
        baseUrl: 'http://127.0.0.1:7460',
        token: 'a b/c',
        webSocketFactory: (url) => {
          urls.push(url);
          return new FakeSocket(url);
        },
        setTimeoutImpl: () => 1,
        clearTimeoutImpl: () => {},
      },
    );
    expect(urls[0]).toContain('token=a+b%2Fc'); // URLSearchParams encodes ' '→'+', '/'→'%2F'
    handle.close();
  });

  it('close() disposes the socket and stops reconnecting', () => {
    const h = harness();
    h.sockets[0]?.open();
    h.handle.close();
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.handle.state()).toBe('closed');
    h.runPending(); // any stray timer is a no-op
    expect(h.sockets).toHaveLength(1);
  });
});
