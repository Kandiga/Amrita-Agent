import { createReadStream, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
  type AmritaEvent,
  type TerminalClientFrame,
  type WsServerFrame,
  isProjectDomainEvent,
  terminalClientFrameSchema,
  terminalServerFrameSchema,
} from '@amrita/protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { ARTIFACT_PREVIEW_CSP } from './artifact-preview.ts';
import {
  type CookieMode,
  clearSessionCookie,
  requestToken,
  resolveCookieMode,
  sessionFromCookie,
  sessionSetCookie,
  tokensMatch,
} from './auth.ts';
import {
  type BrowserTrust,
  cookieOriginAllowed,
  isTrustedBrowserOrigin,
  resolveBrowserTrust,
} from './browser-origin.ts';
import type { AmritaKernel } from './kernel.ts';
import { dispatch } from './rpc.ts';
import { type TerminalBridge, attachTerminalBridge } from './terminal-bridge.ts';

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
  /** Explicit trusted browser origins (tests); production resolves from env. */
  trustedOrigins?: string[];
  /** Force the secure-cookie (TLS/__Host-) mode (tests); production reads env. */
  cookieSecure?: boolean;
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
 * ADR-0057: a tight per-source budget for `POST /pair` — 5 attempts/minute.
 * With single-use 120s codes (~39 bits) this makes online guessing hopeless
 * while a fumbled retype still has room. Same bounded-map posture as the hub.
 */
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX_ATTEMPTS = 5;
const pairHits = new Map<string, { count: number; resetAt: number }>();

export function allowPairAttempt(ip: string, now = Date.now()): boolean {
  const hit = pairHits.get(ip);
  if (!hit || now > hit.resetAt) {
    if (pairHits.size >= PUBLIC_MAX_KEYS) {
      for (const [k, v] of pairHits) if (now > v.resetAt) pairHits.delete(k);
      if (pairHits.size >= PUBLIC_MAX_KEYS) return false;
    }
    pairHits.set(ip, { count: 1, resetAt: now + PAIR_WINDOW_MS });
    return true;
  }
  if (hit.count >= PAIR_MAX_ATTEMPTS) return false;
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

/**
 * ADR-0057 hardening headers, applied to every daemon app/static response.
 *
 * The app CSP is STRICT (finding 3): NO `script-src 'unsafe-inline'`. Vite emits
 * external module scripts (`script-src 'self'`), so nothing inline is needed —
 * and dropping it means an injected inline script cannot run with the app's
 * same-origin authority (call `/rpc`, open a privileged WS). Generated HTML
 * previews no longer inherit this policy: they are served from the dedicated
 * `/artifact` route with their OWN CSP (ARTIFACT_PREVIEW_CSP, connect-src 'none')
 * inside an opaque-origin sandbox, so they keep working without weakening the app.
 * `style-src 'unsafe-inline'` stays (React inline styles; a style cannot call an API).
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
    "frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'self'",
};

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

/**
 * SEC5-1: `/pair` and `/session/logout` are browser session-lifecycle routes. A
 * hostile same-site page (another `localhost:PORT`) must not be able to spend a
 * pairing code or force a logout, so both require a PRESENT trusted dashboard
 * `Origin` AND a JSON content-type — a cross-site `<form>`/no-CORS request can
 * supply neither. Bearer/CLI clients use bearer routes, never these.
 */
function browserLifecycleOk(
  origin: string | undefined,
  contentType: string | string[] | undefined,
  trust: BrowserTrust,
): boolean {
  const ct = (
    Array.isArray(contentType) ? contentType.join(',') : (contentType ?? '')
  ).toLowerCase();
  return isTrustedBrowserOrigin(origin, trust) && ct.includes('application/json');
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
  trust: BrowserTrust,
  cookieMode: CookieMode,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  applySecurityHeaders(res);

  // CORS: reflect the origin when allowed (see corsAllowedOrigin), and answer
  // preflights before auth — a preflight never carries the bearer.
  const allowedOrigin = corsAllowedOrigin(origin);
  applyCors(res, allowedOrigin);
  if (method === 'OPTIONS') {
    res.writeHead(allowedOrigin ? 204 : 403);
    res.end();
    return;
  }

  // Does this request carry a live browser session cookie (ADR-0057)?
  const sessionId = sessionFromCookie(
    typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
  );
  const hasSession = sessionId !== undefined && kernel.checkBrowserSession(sessionId);

  // `/health` stays public for liveness probes, but the payload is minimal
  // unless the caller is authenticated — an unauthenticated stranger learns
  // nothing about the DB path, row counts, or lane posture (ADR-0057).
  if (method === 'GET' && url.pathname === '/health') {
    // tokensMatch('' , …) is true — with auth disabled the whole API is open,
    // so hiding health alone would be theater; the minimal shape is for the
    // normal case of a configured token and an unauthenticated stranger.
    const bearer = requestToken(req.headers.authorization, url.searchParams.get('token'));
    const authed = hasSession || tokensMatch(authToken, bearer);
    sendJson(res, 200, authed ? kernel.health() : { ok: true, name: 'amritad' });
    return;
  }

  // ADR-0057: pairing + session lifecycle. Public by necessity (they BOOTSTRAP
  // auth), rate-limited, and worth nothing without a live code — but SEC5-1: a
  // browser-lifecycle route, so a trusted Origin + JSON is required (when auth
  // is configured) BEFORE the rate limiter or the code is ever touched, so a
  // hostile same-site page can neither spend the code nor exhaust the limiter.
  if (method === 'POST' && url.pathname === '/pair') {
    if (authToken && !browserLifecycleOk(origin, req.headers['content-type'], trust)) {
      sendJson(res, 403, { error: { code: 'forbidden', message: 'untrusted origin' } });
      return;
    }
    if (!allowPairAttempt(publicRateKey(req))) {
      sendJson(res, 429, { error: { code: 'rate_limited', message: 'too many pairing attempts' } });
      return;
    }
    let code = '';
    try {
      const body: unknown = JSON.parse(await readBody(req));
      if (typeof body === 'object' && body !== null && 'code' in body) {
        const c = (body as { code: unknown }).code;
        if (typeof c === 'string') code = c;
      }
    } catch {
      sendJson(res, 400, { error: { code: 'invalid_request', message: 'invalid JSON body' } });
      return;
    }
    const newSession = code ? kernel.pairBrowserSession(code) : null;
    if (!newSession) {
      sendJson(res, 401, {
        error: { code: 'unauthorized', message: 'invalid or expired pairing code' },
      });
      return;
    }
    res.setHeader('set-cookie', sessionSetCookie(newSession, cookieMode));
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === 'GET' && url.pathname === '/session') {
    // "May this browser use the app?" — with auth disabled the answer is
    // always yes (the whole API is open), so the SPA never shows a gate.
    res.writeHead(hasSession || !authToken ? 204 : 401);
    res.end();
    return;
  }
  if (method === 'POST' && url.pathname === '/session/logout') {
    // SEC5-1: same-site logout CSRF/DoS — a hostile page must not force a
    // logout/re-pair. Require a trusted Origin + JSON (when auth is configured).
    if (authToken && !browserLifecycleOk(origin, req.headers['content-type'], trust)) {
      sendJson(res, 403, { error: { code: 'forbidden', message: 'untrusted origin' } });
      return;
    }
    kernel.revokeBrowserSession(sessionId);
    res.setHeader('set-cookie', clearSessionCookie(cookieMode));
    res.writeHead(204);
    res.end();
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

  // ADR-0057 finding 3: the sandboxed artifact preview. The ticket IN THE PATH
  // is the only auth (worthless elsewhere), so this is reachable WITHOUT the
  // bearer/cookie — exactly like the workspace ticket. It serves untrusted
  // generated HTML with its OWN CSP (ARTIFACT_PREVIEW_CSP: default-src 'none',
  // connect-src 'none'), so the app document can keep a STRICT CSP and the
  // preview still cannot reach the network, call /rpc, or open a WebSocket.
  const artifactMatch = /^\/artifact\/([A-Za-z0-9]+)\/t\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
  if (method === 'GET' && artifactMatch) {
    const html = kernel.readArtifactPreview(artifactMatch[1] ?? '', artifactMatch[2] ?? '');
    if (html === null) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'no such artifact preview' } });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': ARTIFACT_PREVIEW_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // No caching: a preview is ephemeral and ticket-scoped.
      'cache-control': 'no-store',
    });
    res.end(html);
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
  // ADR-0057: a live browser session cookie is as good as the bearer, BUT a
  // cookie is a browser credential — it is honored only when
  //   (a) the request comes from a trusted dashboard ORIGIN (finding 1: the
  //       browser-set Origin is the unforgeable discriminator; a same-site page
  //       on another localhost port is a different origin and rejected), AND
  //   (b) a mutation carries `application/json` (a cross-origin <form> cannot,
  //       so this is belt-and-braces CSRF under SameSite=Strict).
  // The bearer path ignores Origin entirely, preserving CLI/programmatic clients.
  if (authToken) {
    const provided = requestToken(req.headers.authorization, url.searchParams.get('token'));
    const bearerOk = tokensMatch(authToken, provided);
    const contentTypeOk =
      method === 'GET' ||
      (req.headers['content-type'] ?? '').toString().toLowerCase().includes('application/json');
    const cookieOk = hasSession && cookieOriginAllowed(origin, method, trust) && contentTypeOk;
    if (!bearerOk && !cookieOk) {
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
  // The trusted-origin authority (finding 1). Resolved from env, plus the
  // daemon's own bound origin (assigned in the listen callback below so direct
  // dev access to a random test port is trusted). Explicit override for tests.
  let trust: BrowserTrust = opts.trustedOrigins
    ? { origins: new Set(opts.trustedOrigins) }
    : resolveBrowserTrust({});
  // Secure-cookie mode (finding 2): server-owned; an explicit opt (tests) wins,
  // else AMRITA_WEB_TLS. Never derived from a request header.
  const cookieMode: CookieMode =
    opts.cookieSecure === undefined ? resolveCookieMode() : { secure: opts.cookieSecure };
  const server = createServer((req, res) => {
    handleHttp(kernel, req, res, authToken, trust, cookieMode).catch(() => {
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
    const terminalMatch = /^\/lanes\/([A-Za-z0-9_-]+)\/terminal$/.exec(url.pathname);
    if (url.pathname !== '/events/ws' && !terminalMatch) {
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
    // Authorization header, so a `?token=` query parameter is accepted too —
    // and per ADR-0057 the session cookie rides the upgrade automatically,
    // which is how the SPA authenticates without ever holding the bearer.
    //
    // Finding 1 — the live hole: a WS upgrade has NO CORS/preflight, so a cookie
    // alone would let a same-site page on another port hijack the socket. When
    // authenticating by COOKIE we therefore also require a trusted, present
    // Origin (browsers always send it on a WS handshake). Bearer auth ignores
    // Origin, preserving CLI clients.
    if (authToken) {
      const provided = requestToken(req.headers.authorization, url.searchParams.get('token'));
      const bearerOk = tokensMatch(authToken, provided);
      const cookieSession = sessionFromCookie(
        typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      );
      const wsOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const cookieOk =
        kernel.checkBrowserSession(cookieSession) && cookieOriginAllowed(wsOrigin, 'WS', trust);
      if (!bearerOk && !cookieOk) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    // The embedded session terminal (ADR-0052): one socket ⇄ one tmux control-
    // mode child. Ownership rules mirror the snapshot RPC — the lane must belong
    // to the REQUESTED project and be interactive; foreign and missing lanes are
    // indistinguishable. Frames are schema-parsed on both sides; nothing persists.
    if (terminalMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const live = ws as LiveSocket;
        live.isAlive = true;
        ws.on('pong', () => {
          live.isAlive = true;
        });
        const laneId = terminalMatch[1] ?? '';
        const projectId = url.searchParams.get('projectId');
        const lane = kernel.getLane(laneId);
        if (
          !projectId ||
          !lane ||
          lane.projectId !== projectId ||
          !lane.kind.endsWith('-tmux') ||
          lane.status === 'completed' ||
          lane.status === 'aborted'
        ) {
          ws.close(1008, 'no such session');
          return;
        }
        let bridge: TerminalBridge;
        try {
          bridge = attachTerminalBridge({
            sessionName: `amrita-${laneId}`,
            onOutput: (data) =>
              safeSend(ws, JSON.stringify(terminalServerFrameSchema.parse({ t: 'output', data }))),
            onExit: (reason) => {
              safeSend(ws, JSON.stringify(terminalServerFrameSchema.parse({ t: 'exit', reason })));
              ws.close(1000, 'session ended');
            },
          });
        } catch {
          ws.close(1011, 'terminal unavailable');
          return;
        }
        ws.on('message', (raw) => {
          let frame: TerminalClientFrame;
          try {
            frame = terminalClientFrameSchema.parse(JSON.parse(String(raw)));
          } catch {
            return; // an unparseable frame is dropped, never interpreted
          }
          if (frame.t === 'input') bridge.write(frame.data);
          else bridge.resize(frame.cols, frame.rows);
        });
        ws.on('close', () => bridge.close());
        ws.on('error', () => bridge.close());
      });
      return;
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
      // Now that the bound port is known, trust the daemon's OWN origin too (so a
      // browser opening the daemon directly in dev is trusted). An explicit
      // trustedOrigins override (tests) is authoritative and not widened here.
      if (!opts.trustedOrigins) trust = resolveBrowserTrust({ selfPort: port });
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
