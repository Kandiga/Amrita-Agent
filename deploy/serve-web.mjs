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
 *   node deploy/serve-web.mjs [--port 7461] [--daemon 127.0.0.1:7460] [--dist <dir>]
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

/** Routes forwarded to the daemon — everything else is static. */
const PROXY_PREFIXES = ['/rpc', '/events', '/health'];

function proxyHttp(req, res) {
  const upstream = httpRequest(
    {
      host: DAEMON_HOST,
      port: DAEMON_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `${DAEMON_HOST}:${DAEMON_PORT}` },
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
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (PROXY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    proxyHttp(req, res);
    return;
  }
  serveStatic(req, res);
});

// WS passthrough for /events/ws: replay the original handshake to the daemon
// and splice the sockets. The daemon still authenticates the ?token= itself.
server.on('upgrade', (req, socket, head) => {
  if (!(req.url ?? '').startsWith('/events/ws')) {
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

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(
    `amrita-web serving ${DIST}\n  http://0.0.0.0:${PORT}  →  daemon ${DAEMON_HOST}:${DAEMON_PORT} (bearer auth unchanged)\n`,
  );
});
