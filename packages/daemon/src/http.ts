import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { requestToken, tokensMatch } from './auth.ts';
import type { AmritaKernel } from './kernel.ts';
import { dispatch } from './rpc.ts';

/**
 * A small local HTTP + WebSocket surface over the kernel/RPC. Binds to localhost
 * by default. No framework — three routes + one WS endpoint. No frame or response
 * ever carries a secret value (the RPC/kernel layer already guarantees that).
 *
 *   GET  /health                                  → kernel health (always public)
 *   POST /rpc                                      → async JSON-RPC dispatch        [auth]
 *   GET  /events?conversationId=&sinceSeq=         → replay persisted events        [auth]
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

  sendJson(res, 404, {
    error: { code: 'not_found', message: `no route: ${method} ${url.pathname}` },
  });
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
        ws.send(JSON.stringify({ t: 'event', event: ev }));
        lastSeq = ev.seq;
      }
      ws.send(JSON.stringify({ t: 'replayed', conversationId, sinceSeq: lastSeq }));

      // Live fan-out: forward newly appended events for this conversation.
      const unsubscribe = kernel.store.subscribe((ev) => {
        if (ev.conversationId === conversationId && ev.seq > lastSeq) {
          lastSeq = ev.seq;
          ws.send(JSON.stringify({ t: 'event', event: ev }));
        }
      });
      ws.on('close', unsubscribe);
      ws.on('error', unsubscribe);
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
