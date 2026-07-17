#!/usr/bin/env node
/**
 * Amrita web preview server — serves the built web app (apps/web/dist) and
 * proxies the daemon surface (`POST /rpc`, `GET /events`, `WS /events/ws`)
 * from the SAME origin, so the browser client needs no CORS and no base URL.
 *
 * Zero dependencies (node:http/net/fs only). Auth is untouched: the daemon's
 * bearer token still gates every proxied route except /health — this server
 * adds no authentication bypass and holds no secret.
 *
 *   node deploy/serve-web.mjs [--port 7461] [--host 127.0.0.1] [--daemon 127.0.0.1:7460] [--dist <dir>]
 *
 * ADR-0057: binds LOOPBACK by default — exposing the dashboard beyond this
 * machine is an explicit operator decision (`--host 0.0.0.0` or
 * AMRITA_WEB_HOST), never a surprise default.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', '7461'));
const HOST = arg('host', process.env.AMRITA_WEB_HOST || '127.0.0.1');
const DAEMON = arg('daemon', '127.0.0.1:7460');
const [DAEMON_HOST, DAEMON_PORT_RAW] = DAEMON.split(':');
const DAEMON_PORT = Number(DAEMON_PORT_RAW ?? '7460');
const DIST = resolve(
  arg('dist', join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'dist')),
);

if (!existsSync(join(DIST, 'index.html'))) {
  process.stderr.write(
    `amrita-web: no build at ${DIST} — run \`pnpm --dir apps/web build\` first (honest refusal, nothing to serve)\n`,
  );
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Routes forwarded to the daemon — everything else is static.
 *  ADR-0057: /pair and /session are the browser's auth bootstrap — they MUST
 *  reach the daemon (the E3 smoke failed exactly here when they fell through
 *  to the SPA fallback and pairing silently never happened). */
const PROXY_PREFIXES = ['/rpc', '/events', '/health', '/lanes', '/p', '/pair', '/session'];

function proxyHttp(req, res) {
  // This process is the internet-facing edge; the daemon behind it is loopback.
  // Append the TRUE peer as the rightmost X-Forwarded-For hop so the daemon's
  // public-hub rate limiter can key on the real visitor instead of 127.0.0.1.
  // Appending (not replacing) means a client that pre-seeds the header cannot
  // forge the rightmost entry — the one the daemon trusts.
  const peer = req.socket.remoteAddress ?? '';
  const priorXff = req.headers['x-forwarded-for'];
  const forwardedFor = priorXff ? `${priorXff}, ${peer}` : peer;

  const upstream = httpRequest(
    {
      host: DAEMON_HOST,
      port: DAEMON_PORT,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `${DAEMON_HOST}:${DAEMON_PORT}`,
        'x-forwarded-for': forwardedFor,
      },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"daemon_unreachable","message":"amritad is not answering"}}');
  });
  req.pipe(upstream);
}

/**
 * ADR-0057 hardening headers on static responses. AUTHORITY:
 * `SECURITY_HEADERS` in packages/daemon/src/http.ts — proxied responses carry
 * the daemon's copy; these literals mirror it for static files and a fitness
 * test (daemon/test/http-auth.test.ts) fails if the two drift apart.
 */
const STATIC_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
    "frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; " +
    "frame-ancestors 'self'",
};

function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // Path-jail: normalize inside dist; anything escaping resolves to index.html.
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, rel === '/' || rel === '\\' ? 'index.html' : rel);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    file = join(DIST, 'index.html'); // SPA fallback
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
    ...STATIC_SECURITY_HEADERS,
  });
  // pipe() does NOT forward the source's 'error' event, so a read that fails
  // mid-stream (an unlink race during a redeploy, an I/O error) would otherwise
  // throw unhandled and take the whole edge server down. Handle it explicitly.
  const stream = createReadStream(file);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('read error');
  });
  stream.pipe(res);
}

const server = createServer((req, res) => {
  // One bad request must never take down the internet-facing edge. Any throw in
  // routing/serving becomes a clean 500 instead of an uncaught exception.
  try {
    const path = (req.url ?? '/').split('?')[0];
    if (PROXY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
      proxyHttp(req, res);
      return;
    }
    serveStatic(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
  }
});

// WS passthrough for /events/ws and the embedded session terminal (ADR-0052):
// replay the original handshake to the daemon and splice the sockets. The daemon
// still authenticates the ?token= and validates lane ownership itself.
server.on('upgrade', (req, socket, head) => {
  const path = req.url ?? '';
  const isTerminal = /^\/lanes\/[A-Za-z0-9_-]+\/terminal(\?|$)/.test(path);
  if (!path.startsWith('/events/ws') && !isTerminal) {
    socket.destroy();
    return;
  }
  const upstream = connect(DAEMON_PORT, DAEMON_HOST, () => {
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${headerLines.join('\r\n')}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const drop = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  socket.on('error', drop);
});

// A bind failure (port already taken, no permission) must be an honest one-liner
// and a clean exit, not a raw uncaught stack from the internet-facing process.
server.on('error', (e) => {
  process.stderr.write(`amrita-web: cannot bind ${PORT}: ${e.code ?? e.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `amrita-web serving ${DIST}\n  http://${HOST}:${PORT}  →  daemon ${DAEMON_HOST}:${DAEMON_PORT} (auth enforced by the daemon)\n`,
  );
});
