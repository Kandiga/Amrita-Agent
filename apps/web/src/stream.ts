/**
 * A small, typed WebSocket client for the daemon's live event stream
 * (`WS /events/ws`). It is deliberately framework-free and injectable: tests
 * pass a fake socket factory and fake timers, so no real network or clock is
 * touched.
 *
 * Frame contract (authoritative: `packages/daemon/src/http.ts`):
 *   { t: 'event',    event }                          // one per replayed + live event
 *   { t: 'replayed', conversationId, sinceSeq }       // marker once replay is done
 *
 * Behaviour:
 * - parses both frame kinds; a malformed frame is dropped, never thrown;
 * - tracks the highest `seq` seen, so a reconnect resumes via `?sinceSeq=` and
 *   never re-requests history it already has (the transcript reducer de-dupes
 *   any overlap by event id anyway);
 * - reconnects with bounded exponential backoff, surfacing connection state;
 * - never logs a frame payload.
 */

import type { AmritaEventLite } from './api.ts';

/** One frame on the `/events/ws` stream. */
export type StreamFrame =
  | { t: 'event'; event: AmritaEventLite }
  | { t: 'replayed'; conversationId: string; sinceSeq: number };

/** The subset of the browser `WebSocket` API the client touches — injectable for tests. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'error' | 'closed';

export interface StreamHandlers {
  /** Every event frame (replayed and live), in arrival order. */
  onEvent(ev: AmritaEventLite): void;
  /** Connection-state transitions, for a status pill. */
  onState?(state: StreamState): void;
  /** The server finished replaying history (fires on every (re)connect). */
  onReplayed?(sinceSeq: number): void;
}

export interface StreamOptions {
  sinceSeq?: number;
  /** HTTP(S) origin of the daemon (converted to ws/wss). Empty → page origin. */
  baseUrl?: string;
  /** Auth token, appended as `?token=` (browser WS cannot set headers). */
  token?: string;
  webSocketFactory?: WebSocketFactory;
  /** Delays (ms) between reconnect attempts; the last entry repeats. */
  backoffMs?: number[];
  /** Consecutive connection failures before giving up with state `error`. */
  maxRetries?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface EventStreamHandle {
  close(): void;
  state(): StreamState;
}

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 5000];

/** Convert an HTTP(S) origin to a ws(s) origin; empty → the page origin. */
export function toWsBase(baseUrl: string): string {
  if (baseUrl) {
    if (baseUrl.startsWith('https:')) return `wss:${baseUrl.slice('https:'.length)}`;
    if (baseUrl.startsWith('http:')) return `ws:${baseUrl.slice('http:'.length)}`;
    return baseUrl; // already ws/wss, or a relative base
  }
  if (typeof location === 'undefined') return '';
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
}

function defaultFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

/**
 * Open a reconnecting subscription to a conversation's event stream. Returns a
 * handle whose `close()` disposes the socket and cancels any pending retry.
 */
export function openEventStream(
  conversationId: string,
  handlers: StreamHandlers,
  opts: StreamOptions = {},
): EventStreamHandle {
  const factory = opts.webSocketFactory ?? defaultFactory;
  const wsBase = toWsBase(opts.baseUrl ?? '');
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxRetries = opts.maxRetries ?? 6;
  const setT = opts.setTimeoutImpl ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT =
    opts.clearTimeoutImpl ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let lastSeq = opts.sinceSeq ?? 0;
  let state: StreamState = 'connecting';
  let retries = 0;
  let closed = false;
  let ws: WebSocketLike | null = null;
  let timer: unknown = null;

  const setState = (s: StreamState): void => {
    if (state === s) return;
    state = s;
    handlers.onState?.(s);
  };

  const buildUrl = (): string => {
    const params = new URLSearchParams({
      conversationId,
      sinceSeq: String(lastSeq),
    });
    if (opts.token) params.set('token', opts.token);
    return `${wsBase}/events/ws?${params.toString()}`;
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    if (retries >= maxRetries) {
      setState('error'); // gave up — caller falls back to GET /events replay
      return;
    }
    const delay = backoff[Math.min(retries, backoff.length - 1)] ?? 1000;
    retries += 1;
    setState('reconnecting');
    timer = setT(connect, delay);
  };

  function connect(): void {
    if (closed) return;
    let socket: WebSocketLike;
    try {
      socket = factory(buildUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;
    if (state !== 'connecting') setState('connecting');

    socket.onopen = () => {
      retries = 0;
      setState('open');
    };
    socket.onmessage = (m) => {
      let frame: StreamFrame;
      try {
        frame = JSON.parse(String(m.data)) as StreamFrame;
      } catch {
        return; // malformed frame: drop, never throw
      }
      if (frame && frame.t === 'event' && frame.event) {
        if (typeof frame.event.seq === 'number' && frame.event.seq > lastSeq) {
          lastSeq = frame.event.seq;
        }
        handlers.onEvent(frame.event);
      } else if (frame && frame.t === 'replayed') {
        handlers.onReplayed?.(frame.sinceSeq);
      }
    };
    socket.onerror = () => {
      // the paired `onclose` drives reconnection
    };
    socket.onclose = () => {
      if (ws !== socket) return; // a newer socket has superseded this one
      ws = null;
      if (!closed) scheduleReconnect();
    };
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (timer !== null) clearT(timer);
      const socket = ws;
      ws = null;
      setState('closed');
      socket?.close();
    },
    state: () => state,
  };
}
