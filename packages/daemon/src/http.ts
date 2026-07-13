import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { AmritaEvent, WsServerFrame } from '@amrita/protocol';
import { WebSocketServer } from 'ws';
import { requestToken, tokensMatch } from './auth.ts';
import type { AmritaKernel } from './kernel.ts';
import { dispatch } from './rpc.ts';

/** Seal one WS frame to the protocol union (ADR-0032) before serializing. */
function wsFrame(frame: WsServerFrame): string {
  return JSON.stringify(frame);
}

/** Wrap a sealed event as its wire frame (every event payload is an object). */
function eventFrame(ev: AmritaEvent): WsServerFrame {
  return { t: 'event', event: ev };
}

/**
 * A small local HTTP + WebSocket surface over the kernel/RPC. Binds to localhost
 * by default. No framework — three routes + one WS endpoint. No frame or response
 * ever carries a secret value (the RPC/kernel layer already guarantees that).
 *
 *   GET  /health                                  → kernel health (always public)
 *   POST /rpc                                      → async JSON-RPC dispatch        [auth]
 *   GET  /events?conversationId=&sinceSeq=         → replay persisted events        [auth]
 *   GET  /lanes/<id>/workspace[/<path>]            → lane workspace files (ADR-0039) [auth]
 *   WS   /events/ws?conversationId=&sinceSeq=      → replay + live fan-out          [auth]
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
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
        'cache-control': 'no-store',
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
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(readFileSync(target));
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
      if (!res.headersSent)
        sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/events/ws') {
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
      const conversationId = url.searchParams.get('conversationId');
      if (!conversationId) {
        ws.close(1008, 'conversationId is required');
        return;
      }
      let lastSeq = Number(url.searchParams.get('sinceSeq') ?? '0') || 0;
      for (const ev of kernel.listEvents(conversationId, lastSeq)) {
        ws.send(wsFrame(eventFrame(ev)));
        lastSeq = ev.seq;
      }
      ws.send(wsFrame({ t: 'replayed', conversationId, sinceSeq: lastSeq }));

      // Live fan-out: forward newly appended events for this conversation.
      const unsubscribe = kernel.store.subscribe((ev) => {
        if (ev.conversationId === conversationId && ev.seq > lastSeq) {
          lastSeq = ev.seq;
          ws.send(wsFrame(eventFrame(ev)));
        }
      });
      // Stream-only fan-out (model.delta): ephemeral, seq 0, never replayed —
      // forwarded as-is without touching lastSeq.
      const unsubscribeStream = kernel.subscribeStream((ev) => {
        if (ev.conversationId === conversationId) {
          ws.send(wsFrame(eventFrame(ev)));
        }
      });
      const cleanup = () => {
        unsubscribe();
        unsubscribeStream();
      };
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0);
      resolve({
        server,
        port,
        host,
        close: () =>
          new Promise<void>((res) => {
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
