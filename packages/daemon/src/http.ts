import { createReadStream, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { type AmritaEvent, type WsServerFrame, isProjectDomainEvent } from '@amrita/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { requestToken, tokensMatch } from './auth.ts';
import type { AmritaKernel } from './kernel.ts';
import { dispatch } from './rpc.ts';

/** Seal one WS frame to the protocol union (ADR-0032) before serializing. */
function wsFrame(frame: WsServerFrame): string {
  return JSON.stringify(frame);
}

/** WS liveness + resource bounds (stability audit). */
const WS_MAX_CONNECTIONS = 512;
const WS_HEARTBEAT_MS = 30_000;
/** If a client's outbound buffer passes this, it cannot keep up — drop it rather
 *  than let the daemon buffer without bound (OOM). */
const WS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Cap replay-on-connect; older history is fetched via GET /events, not the socket. */
const WS_MAX_REPLAY = 1000;

type LiveSocket = WebSocket & { isAlive?: boolean };

/**
 * Send unless the socket is falling behind. A slow/stalled reader otherwise makes
 * the daemon buffer every event forever; past the cap we terminate it (it will
 * reconnect and replay). Returns false if the socket was dropped.
 */
function safeSend(ws: WebSocket, data: string): boolean {
  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    ws.terminate();
    return false;
  }
  ws.send(data);
  return true;
}

/** Wrap a sealed event as its wire frame (every event payload is an object). */
function eventFrame(ev: AmritaEvent): WsServerFrame {
  return { t: 'event', event: ev };
}

/** A project-scoped domain change (ADR-0044). No cursor — see the ADR. */
function projectEventFrame(ev: AmritaEvent): WsServerFrame {
  return { t: 'project-event', event: ev };
}

/** A project-scoped, stream-only session update (ADR-0050). */
function projectSessionEventFrame(ev: AmritaEvent): WsServerFrame {
  return { t: 'project-session-event', event: ev };
}

/**
 * A small local HTTP + WebSocket surface over the kernel/RPC. Binds to localhost
 * by default. No framework — three routes + one WS endpoint. No frame or response
 * ever carries a secret value (the RPC/kernel layer already guarantees that).
 *
 *   GET  /health                                  → kernel health (always public)
 *   GET  /p/<slug>                                 → the public hub (ADR-0045, PUBLIC)
 *   POST /rpc                                      → async JSON-RPC dispatch        [auth]
 *   GET  /events?conversationId=&sinceSeq=         → replay persisted events        [auth]
 *   GET  /lanes/<id>/workspace[/<path>]            → lane workspace files (ADR-0039) [auth]
 *   WS   /events/ws?conversationId=&sinceSeq=&projectId= → replay + live fan-out     [auth]
 *
 * When `authToken` is set, every route except `GET /health` requires a matching
 * bearer token (`Authorization: Bearer …`, or `?token=` for the browser WS that
 * cannot set headers). When it is empty, the surface is open (localhost dev).
 */
export interface HttpServerOptions {
  port?: number;
  host?: string;
  /** Bearer token required for non-health routes. Empty/undefined → no auth. */
  authToken?: string;
}
export interface RunningHttpServer {
  server: Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * A minimal per-IP rate limit for the ONE public route (ADR-0045). Not a security
 * boundary — it is there so the public hub cannot be used to hammer the daemon that
 * also serves the private app.
 */
const PUBLIC_WINDOW_MS = 60_000;
const PUBLIC_MAX_HITS = 60;
// Hard cap so a flood of distinct source addresses (cheap over IPv6) cannot grow
// this map without bound and exhaust the daemon that also serves the private app.
const PUBLIC_MAX_KEYS = 10_000;
const publicHits = new Map<string, { count: number; resetAt: number }>();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The rate-limit key for a public hit.
 *
 * The daemon binds loopback, so the internet reaches `/p/` only through the
 * bundled proxy (`deploy/serve-web.mjs`) — which means `remoteAddress` is
 * `127.0.0.1` for EVERY visitor. Keyed on that alone, all strangers share one
 * bucket (a self-inflicted 429 storm) and the "per-IP" cap protects nothing.
 *
 * So when — and ONLY when — the peer is our own loopback proxy, trust the
 * **rightmost** `x-forwarded-for` hop: that entry is the one the proxy itself
 * appended, so a client cannot spoof it by pre-seeding the header. From any
 * non-loopback peer the header is ignored entirely.
 */
export function publicRateKey(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? 'unknown';
  if (LOOPBACK.has(peer)) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const last = raw?.split(',').pop()?.trim();
    if (last) return last;
  }
  return peer;
}

export function allowPublicHit(ip: string, now = Date.now()): boolean {
  const hit = publicHits.get(ip);
  if (!hit || now > hit.resetAt) {
    // Evict expired windows before admitting a new key, so the steady-state size
    // is bounded by distinct sources seen in the last window.
    if (publicHits.size >= PUBLIC_MAX_KEYS) {
      for (const [k, v] of publicHits) if (now > v.resetAt) publicHits.delete(k);
      // Hard cap: if a distinct-IP flood (cheap over IPv6) fills the map with
      // still-live windows and eviction frees nothing, refuse rather than grow
      // without bound. Fail-closed — a 429 is the right answer to a flood.
      if (publicHits.size >= PUBLIC_MAX_KEYS) return false;
    }
    publicHits.set(ip, { count: 1, resetAt: now + PUBLIC_WINDOW_MS });
    return true;
  }
  if (hit.count >= PUBLIC_MAX_HITS) return false;
  hit.count++;
  return true;
}

/**
 * Browser CORS (integration Phase 7): the Cinema SPA is a different origin, so
 * without these headers no browser page can reach the daemon at all — curl/CLI
 * are unaffected either way. Deny-by-default posture:
 *   - `AMRITA_ALLOWED_ORIGINS` (comma-separated) set → exact-match allowlist.
 *   - unset → LOCAL pages only (http(s)://localhost|127.0.0.1, any port); any
 *     remote origin must be explicitly allowlisted.
 * CORS is reflection only — the bearer token still gates every non-health route.
 */
export function corsAllowedOrigin(
  origin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!origin) return null;
  const list = (env.AMRITA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length > 0) return list.includes(origin) ? origin : null;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : null;
}

function applyCors(res: ServerResponse, allowed: string | null): void {
  if (!allowed) return;
  res.setHeader('access-control-allow-origin', allowed);
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('vary', 'Origin');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // PAUSE, don't destroy: destroying the socket first means the 400/413 can
        // never be written. Stop reading (so nothing more is buffered) and let the
        // caller send a structured error and end the response normally.
        aborted = true;
        req.pause();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function handleHttp(
  kernel: AmritaKernel,
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';

  // CORS: reflect the origin when allowed (see corsAllowedOrigin), and answer
  // preflights before auth — a preflight never carries the bearer.
  const allowedOrigin = corsAllowedOrigin(
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
  );
  applyCors(res, allowedOrigin);
  if (method === 'OPTIONS') {
    res.writeHead(allowedOrigin ? 204 : 403);
    res.end();
    return;
  }

  // `/health` is always public (liveness probes, dashboards).
  if (method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, kernel.health());
    return;
  }

  // ADR-0039 amendment: the canvas iframe reads workspaces with a lane-scoped
  // ticket IN THE PATH (so the document's relative subresources inherit it).
  // The ticket is read-only, expiring, and worthless on every other route.
  const ticketMatch = /^\/lanes\/([A-Za-z0-9]+)\/workspace\/t\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(
    url.pathname,
  );
  if (method === 'GET' && ticketMatch) {
    const laneId = ticketMatch[1] ?? '';
    if (!kernel.checkWorkspaceTicket(laneId, ticketMatch[2] ?? '')) {
      sendJson(res, 401, {
        error: { code: 'unauthorized', message: 'missing or invalid workspace ticket' },
      });
      return;
    }
    serveLaneWorkspace(kernel, res, laneId, decodeURIComponent(ticketMatch[3] ?? ''));
    return;
  }

  /**
   * ADR-0045: the public stakeholder hub. THE FIRST HOLE EVER PUNCHED IN THE AUTH
   * GATE, and it is deliberately the dumbest component in the system:
   *
   *   - it executes ZERO SQL — it reads pre-rendered bytes from one fixed directory;
   *   - the slug is regex-validated BEFORE any path is constructed;
   *   - the resolved path is re-checked to be inside the publish directory;
   *   - the CSP forbids every outbound channel, so a published page cannot phone
   *     home or call back into the daemon;
   *   - a missing page and a revoked page are indistinguishable (both 404) — the
   *     404 must not become an oracle for "this project exists".
   *
   * Rate-limited per IP, so the public route cannot be used to load-test the daemon
   * that also serves the private app.
   */
  const pubMatch = /^\/p\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
  if (method === 'GET' && pubMatch) {
    const ip = publicRateKey(req);
    if (!allowPublicHit(ip)) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('slow down');
      return;
    }
    const html = kernel.readPublishedHub(pubMatch[1] ?? '');
    if (!html) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      // No caching: a revoke must take effect immediately, and the page is served
      // locally and cheaply, so there is nothing to gain by letting a copy linger.
      'cache-control': 'no-store',
    });
    res.end(html);
    return;
  }

  // Everything else is gated when a token is configured. Gate before route
  // matching so an unauthenticated caller cannot probe which routes exist.
  if (authToken) {
    const provided = requestToken(req.headers.authorization, url.searchParams.get('token'));
    if (!tokensMatch(authToken, provided)) {
      sendJson(res, 401, {
        error: { code: 'unauthorized', message: 'missing or invalid bearer token' },
      });
      return;
    }
  }

  if (method === 'POST' && url.pathname === '/rpc') {
    let raw: unknown;
    try {
      raw = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: { code: 'invalid_request', message: 'invalid JSON body' } });
      return;
    }
    sendJson(res, 200, await dispatch(kernel, raw)); // RPC errors live in the body, HTTP stays 200
    return;
  }

  if (method === 'GET' && url.pathname === '/events') {
    const conversationId = url.searchParams.get('conversationId');
    if (!conversationId) {
      sendJson(res, 400, {
        error: { code: 'invalid_params', message: 'conversationId is required' },
      });
      return;
    }
    const sinceSeq = Number(url.searchParams.get('sinceSeq') ?? '0') || 0;
    sendJson(res, 200, { conversationId, events: kernel.listEvents(conversationId, sinceSeq) });
    return;
  }

  // ADR-0039: read-only lane workspace files, realpath-confined. This is how
  // the canvas shows what a lane actually built (page, game, tool) — live.
  const wsMatch = /^\/lanes\/([A-Za-z0-9]+)\/workspace(?:\/(.*))?$/.exec(url.pathname);
  if (method === 'GET' && wsMatch) {
    serveLaneWorkspace(kernel, res, wsMatch[1] ?? '', decodeURIComponent(wsMatch[2] ?? ''));
    return;
  }

  sendJson(res, 404, {
    error: { code: 'not_found', message: `no route: ${method} ${url.pathname}` },
  });
}

const WORKSPACE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Workspace responses are hostile-until-proven: lane-built content executes in
 * the canvas sandbox, so the server ALSO forbids every external channel — no
 * fetch/beacon, no external subresources, no forms — and never sends a
 * Referer. Self-contained pages and games (inline CSS/JS, same-origin assets)
 * work; exfiltration does not.
 */
const WORKSPACE_SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "sandbox allow-scripts; default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

/**
 * Serve one file from a lane's workspace (ADR-0039). Read-only; every resolved
 * path must stay inside the workspace realpath (symlinks out are refused). `/`
 * serves index.html when present, otherwise an honest generated file listing —
 * so a lane that has not written an entry page yet still shows its progress.
 */
function serveLaneWorkspace(
  kernel: AmritaKernel,
  res: ServerResponse,
  laneId: string,
  rel: string,
): void {
  const lane = kernel.getLane(laneId);
  const paths = lane
    ? (JSON.parse(lane.mandateJson) as { scope?: { paths?: string[] } }).scope?.paths
    : undefined;
  const root = paths?.[0];
  if (!lane || !root) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'no such lane workspace' } });
    return;
  }
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    sendJson(res, 404, { error: { code: 'not_found', message: 'workspace does not exist yet' } });
    return;
  }

  const resolveConfined = (relPath: string): string | null => {
    const abs = resolve(rootReal, relPath);
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) return null;
    try {
      const real = realpathSync(abs); // refuses symlinks escaping the root
      if (real !== rootReal && !real.startsWith(rootReal + sep)) return null;
      return real;
    } catch {
      return null;
    }
  };

  let target = resolveConfined(rel);
  if (rel && target === null) {
    // distinguish escape attempts (403) from plain missing files (404)
    const abs = resolve(rootReal, rel);
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
      sendJson(res, 403, { error: { code: 'forbidden', message: 'path escapes the workspace' } });
      return;
    }
  }
  if (target && statSync(target).isDirectory()) {
    target = resolveConfined(join(rel, 'index.html'));
    if (target === null) {
      // honest listing: what the lane has written so far
      const dir = resolveConfined(rel);
      const entries = dir ? readdirSync(dir, { withFileTypes: true }) : [];
      const items = entries
        .map((e) => {
          const href = `${e.name}${e.isDirectory() ? '/' : ''}`;
          return `<li><a href="${escapeHtml(href)}">${escapeHtml(href)}</a></li>`;
        })
        .join('');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        ...WORKSPACE_SECURITY_HEADERS,
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>lane workspace</title><body style="font-family:system-ui;padding:24px;color:#3d3d3a;background:#faf9f5"><h3 style="margin:0 0 4px">Lane workspace</h3><p style="margin:0 0 14px;font-size:13px;color:#87867f">${
          entries.length === 0
            ? 'Nothing written yet — the lane is still working.'
            : 'No index.html yet — files so far:'
        }</p><ul>${items}</ul></body>`,
      );
      return;
    }
  }
  if (target === null) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'no such file in workspace' } });
    return;
  }
  const type = WORKSPACE_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, ...WORKSPACE_SECURITY_HEADERS });
  // Stream rather than readFileSync so a large artifact does not pull its whole
  // size into heap; an I/O error mid-stream tears the response down instead of
  // throwing unhandled (pipe does not forward the source's error).
  const stream = createReadStream(target);
  stream.on('error', () => {
    res.destroyed || res.writableEnded ? undefined : res.destroy();
  });
  stream.pipe(res);
}

/** Start the HTTP/WS server. Resolves once listening; `port` is the bound port. */
export function startHttpServer(
  kernel: AmritaKernel,
  opts: HttpServerOptions = {},
): Promise<RunningHttpServer> {
  const host = opts.host ?? '127.0.0.1';
  const authToken = opts.authToken ?? '';
  const server = createServer((req, res) => {
    handleHttp(kernel, req, res, authToken).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
      } else if (!res.writableEnded && !res.destroyed) {
        // Headers already flushed — we cannot change the status. Tear the response
        // down so it does not hang the connection (and the client) forever.
        res.destroy();
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  // Heartbeat: a TCP connection can go half-open (client vanishes, no close event)
  // and leak its subscription + buffered memory forever. Ping every tick; a socket
  // that missed the previous pong is dead — terminate it (fires 'close' → cleanup).
  const heartbeat = setInterval(() => {
    for (const client of wss.clients as Set<LiveSocket>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ping();
      } catch {
        /* terminating */
      }
    }
  }, WS_HEARTBEAT_MS);
  heartbeat.unref?.();

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events/ws') {
      socket.destroy();
      return;
    }
    // Cap total concurrent sockets so a connection flood cannot exhaust memory /
    // amplify every event's fan-out without bound.
    if (wss.clients.size >= WS_MAX_CONNECTIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Auth the handshake before upgrading. A browser WebSocket cannot set an
    // Authorization header, so a `?token=` query parameter is accepted too.
    if (authToken) {
      const provided = requestToken(req.headers.authorization, url.searchParams.get('token'));
      if (!tokensMatch(authToken, provided)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const live = ws as LiveSocket;
      live.isAlive = true;
      ws.on('pong', () => {
        live.isAlive = true;
      });
      const conversationId = url.searchParams.get('conversationId');
      if (!conversationId) {
        ws.close(1008, 'conversationId is required');
        return;
      }
      const projectId = url.searchParams.get('projectId');
      const conversation = kernel.getConversation(conversationId);
      if (!conversation) {
        ws.close(1008, 'conversation not found');
        return;
      }
      if (projectId && conversation.projectId !== projectId) {
        ws.close(1008, 'project does not own conversation');
        return;
      }
      let lastSeq = Number(url.searchParams.get('sinceSeq') ?? '0') || 0;
      let replaying = true;
      const durableBuffer: AmritaEvent[] = [];
      const streamBuffer: AmritaEvent[] = [];

      const forwardDurable = (ev: AmritaEvent): void => {
        if (ev.conversationId === conversationId && ev.seq > lastSeq) {
          lastSeq = ev.seq;
          safeSend(ws, wsFrame(eventFrame(ev)));
          return;
        }
        // A domain change elsewhere in the same project. Sent WITHOUT a cursor —
        // `seq` is per-conversation, so a project-wide stream has no global sequence.
        if (
          projectId &&
          ev.projectId === projectId &&
          ev.conversationId !== conversationId &&
          isProjectDomainEvent(ev.type)
        ) {
          safeSend(ws, wsFrame(projectEventFrame(ev)));
        }
      };
      const forwardStream = (ev: AmritaEvent): void => {
        if (ev.conversationId === conversationId) {
          safeSend(ws, wsFrame(eventFrame(ev)));
          return;
        }
        if (projectId && ev.projectId === projectId && ev.type === 'lane.pane') {
          safeSend(ws, wsFrame(projectSessionEventFrame(ev)));
        }
      };

      // Subscribe BEFORE replay. Anything appended while the snapshot is read is
      // buffered, then deduplicated by the conversation sequence when flushed. This
      // closes the replay→subscribe gap that could otherwise lose an event forever.
      const unsubscribe = kernel.store.subscribe((ev) => {
        if (replaying) durableBuffer.push(ev);
        else forwardDurable(ev);
      });
      const unsubscribeStream = kernel.subscribeStream((ev) => {
        if (replaying) streamBuffer.push(ev);
        else forwardStream(ev);
      });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        unsubscribe();
        unsubscribeStream();
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);

      // Bounded replay: a fresh connect with sinceSeq=0 would otherwise pull an
      // entire long conversation into memory at once. Cap it; the client falls
      // back to GET /events for anything older than the window.
      let replayed = 0;
      for (const ev of kernel.listEvents(conversationId, lastSeq)) {
        if (replayed >= WS_MAX_REPLAY) break;
        if (!safeSend(ws, wsFrame(eventFrame(ev)))) {
          replaying = false;
          cleanup();
          return;
        }
        lastSeq = ev.seq;
        replayed += 1;
      }
      replaying = false;
      for (const ev of durableBuffer) forwardDurable(ev);
      for (const ev of streamBuffer) forwardStream(ev);
      safeSend(ws, wsFrame({ t: 'replayed', conversationId, sinceSeq: lastSeq }));
    });
  });

  return new Promise((resolve, reject) => {
    // A bind failure (EADDRINUSE, EACCES) otherwise throws as an uncaught
    // exception with a raw stack and no clean exit. Reject so the caller can
    // report it honestly and exit deliberately. Listener is removed once we are
    // listening, so a later runtime socket error never rejects a settled promise.
    const onListenError = (err: NodeJS.ErrnoException) => reject(err);
    server.on('error', onListenError);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener('error', onListenError);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      resolve({
        server,
        port,
        host,
        close: () =>
          new Promise<void>((res) => {
            // server.close() fires its callback only once EVERY connection is gone.
            // A persistent /events/ws socket never closes on its own, so without
            // terminating live clients first the callback never runs and systemd
            // SIGKILLs the daemon after the full 90s stop-timeout — hanging every
            // restart/deploy. Force each socket shut, then stop accepting new ones.
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
