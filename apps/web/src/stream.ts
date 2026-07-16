/**
 * A small, typed WebSocket client for the daemon's live event stream
 * (`WS /events/ws`). It is deliberately framework-free and injectable: tests
 * pass a fake socket factory and fake timers, so no real network or clock is
 * touched.
 *
 * Frame contract (authoritative: `wsServerFrameSchema` in `@amrita/protocol`,
 * ADR-0032): every incoming frame is parsed against the protocol union —
 *   { t: 'event',    event }                          // one per replayed + live event
 *   { t: 'replayed', conversationId, sinceSeq }       // marker once replay is done
 *
 * Behaviour:
 * - a frame that fails the protocol parse is dropped, never thrown;
 * - tracks the highest `seq` seen, so a reconnect resumes via `?sinceSeq=` and
 *   never re-requests history it already has (the transcript reducer de-dupes
 *   any overlap by event id anyway);
 * - reconnects with bounded exponential backoff, surfacing connection state;
 * - never logs a frame payload.
 */

import { type WsServerFrame, wsServerFrameSchema } from '@amrita/protocol';
import type { AmritaEventLite } from './api.ts';

/** One frame on the `/events/ws` stream (protocol-owned union). */
export type StreamFrame = WsServerFrame;

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
  /**
   * A domain change elsewhere in the SAME project (ADR-0044) — a task dragged in
   * another tab, a Scribe proposal, a CLI write.
   *
   * It carries NO cursor: `seq` is per-conversation, so a project-wide stream has
   * no global sequence. Treat it as a notification and REFETCH the projection;
   * missing one is harmless (the next re-syncs), replaying one is harmless (a
   * refetch is idempotent).
   */
  onProjectEvent?(ev: AmritaEventLite): void;
  /**
   * A live `lane.pane` snapshot from another conversation in this project
   * (ADR-0050). It is ephemeral, does not advance the conversation cursor, and
   * updates only the interactive-session workspace.
   */
  onProjectSessionEvent?(ev: AmritaEventLite): void;
  /** Connection-state transitions, for a status pill. */
  onState?(state: StreamState): void;
  /** The server finished replaying history (fires on every (re)connect). */
  onReplayed?(sinceSeq: number): void;
}

export interface StreamOptions {
  sinceSeq?: number;
  /**
   * Also subscribe to PROJECT-scoped domain changes (ADR-0044) — what makes the
   * board update when a card is dragged in another tab, or the CLI writes a task.
   */
  projectId?: string;
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
    if (opts.projectId) params.set('projectId', opts.projectId);
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
      if (closed || ws !== socket) return;
      retries = 0;
      setState('open');
    };
    socket.onmessage = (m) => {
      if (closed || ws !== socket) return;
      let raw: unknown;
      try {
        raw = JSON.parse(String(m.data));
      } catch {
        return; // malformed frame: drop, never throw
      }
      // ADR-0032: the protocol union is the frame authority; parse or drop.
      const parsed = wsServerFrameSchema.safeParse(raw);
      if (!parsed.success) return;
      const frame = parsed.data;
      if (frame.t === 'event') {
        if (frame.event.seq > lastSeq) lastSeq = frame.event.seq;
        handlers.onEvent(frame.event);
      } else if (frame.t === 'project-event') {
        // Deliberately does NOT touch `lastSeq`: this event belongs to another
        // conversation, and the cursor is per-conversation.
        handlers.onProjectEvent?.(frame.event);
      } else if (frame.t === 'project-session-event') {
        // Defense in depth: the server has the same allowlist, but never let a
        // non-pane stream event cross conversation boundaries in the browser.
        if (frame.event.type === 'lane.pane') handlers.onProjectSessionEvent?.(frame.event);
      } else {
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

  // After maxRetries the socket gives up ('error') forever — a laptop that slept or
  // a dropped Wi-Fi would then never live-update again until a manual reload. When
  // the network or the tab comes back, reset the retry budget and reconnect now.
  const revive = (): void => {
    if (closed) return;
    if (state === 'error' || state === 'reconnecting') {
      retries = 0;
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      connect();
    }
  };
  const onVisible = (): void => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') revive();
  };
  const hasWindow = typeof window !== 'undefined';
  if (hasWindow) {
    window.addEventListener('online', revive);
    document?.addEventListener?.('visibilitychange', onVisible);
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (timer !== null) clearT(timer);
      if (hasWindow) {
        window.removeEventListener('online', revive);
        document?.removeEventListener?.('visibilitychange', onVisible);
      }
      const socket = ws;
      ws = null;
      setState('closed');
      socket?.close();
    },
    state: () => state,
  };
}
