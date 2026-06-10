import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../core/tools/index.ts';
import '../connectors/index.ts';
import { loadConfig, setConfigValue, setSecret, getSecret, redactSecret } from '../shared/config.ts';
import { listProfiles } from '../core/providers/registry.ts';
import { runAgent } from '../core/agent/loop.ts';
import { createSession, getMessages, listSessions } from '../core/store/sessions.ts';
import { listProjects, getProject, createProject } from '../projects/manager.ts';
import { summarizeIdleSessions } from '../core/agent/summarizer.ts';
import { telegramAdapter } from '../channels/telegram/adapter.ts';
import { handleInbound } from '../gateway/gateway.ts';
import { startScheduler, setCronDelivery } from '../scheduler/scheduler.ts';
import { redeemMagicLink, isValidSession, cookieFromHeader, createMagicLink, loginUrl } from './auth.ts';
import { audit } from '../core/store/audit.ts';
import { log } from '../shared/util.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function authed(req: IncomingMessage): boolean {
  return isValidSession(cookieFromHeader(req.headers.cookie));
}

/**
 * Build the HTTP server without listening or starting channels/scheduler.
 * Kept separate from `startDaemon` so the routes can be exercised in tests.
 */
export function createDaemonServer(): Server {
  return createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      log('daemon', `route error: ${err instanceof Error ? err.stack : err}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    // ---- public ----
    if (path === '/healthz') return json(res, 200, { ok: true, name: 'amrita' });

    if (path.startsWith('/auth/')) {
      const token = path.slice('/auth/'.length);
      const session = redeemMagicLink(token);
      if (!session) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<h3>Link expired.</h3><p>Run <code>amrita login-link</code> for a fresh one.</p>');
        return;
      }
      // Mark the cookie Secure when the connection is (or terminates) over TLS,
      // so the session token is never sent in cleartext.
      const xfProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
      const encrypted = (req.socket as { encrypted?: boolean }).encrypted === true;
      const httpsPublic = (loadConfig().daemon.publicUrl ?? '').startsWith('https://');
      const secure = xfProto === 'https' || encrypted || httpsPublic;
      res.writeHead(302, {
        'set-cookie': `amrita_session=${session}; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Lax; Path=/; Max-Age=2592000`,
        location: '/',
      });
      res.end();
      return;
    }

    // ---- static web UI (login screen handles unauthenticated state client-side) ----
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      // Anchor the request under webRoot and verify containment — never trust
      // the raw path. Only serve files of a known content type.
      const base = resolve(webRoot);
      const full = resolve(base, '.' + (path === '/' ? '/index.html' : path));
      const contained = full === base || full.startsWith(base + sep);
      if (contained && existsSync(full) && !full.endsWith('/')) {
        const ext = full.slice(full.lastIndexOf('.'));
        const mime = MIME[ext];
        if (mime) {
          res.writeHead(200, { 'content-type': mime });
          res.end(readFileSync(full));
          return;
        }
      }
      // SPA fallback (also covers unknown types and out-of-root requests).
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(webRoot, 'index.html')));
      return;
    }

    // ---- API (auth required) ----
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });

    if (path === '/api/state' && req.method === 'GET') {
      const cfg = loadConfig(true);
      return json(res, 200, {
        projects: listProjects(),
        model: cfg.model,
        channels: { telegram: cfg.channels.telegram.enabled },
      });
    }

    if (path === '/api/sessions' && req.method === 'GET') {
      const slug = url.searchParams.get('project');
      return json(res, 200, { sessions: listSessions(slug || null, 30) });
    }

    if (path === '/api/messages' && req.method === 'GET') {
      const sessionId = url.searchParams.get('session');
      if (!sessionId) return json(res, 400, { error: 'session required' });
      return json(res, 200, { messages: getMessages(sessionId) });
    }

    if (path === '/api/session/new' && req.method === 'POST') {
      const body = await readBody(req);
      const slug = (body.projectSlug as string | null) || null;
      const session = createSession(slug, 'web');
      return json(res, 200, { session });
    }

    if (path === '/api/project/new' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return json(res, 400, { error: 'name required' });
      const project = createProject(String(body.name), body.workingDir ? String(body.workingDir) : null);
      return json(res, 200, { project });
    }

    if (path === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      const sessionId = String(body.sessionId ?? '');
      const text = String(body.text ?? '').trim();
      if (!sessionId || !text) return json(res, 400, { error: 'sessionId and text required' });
      const slug = (body.projectSlug as string | null) || null;
      const project = slug ? getProject(slug) : null;

      // SSE stream of agent events.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      for await (const event of runAgent({
        sessionId,
        project,
        channel: 'web',
        userText: text,
        signal: controller.signal,
      })) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
      return;
    }

    if (path === '/api/settings' && req.method === 'GET') {
      const cfg = loadConfig(true);
      const providers = listProfiles().map((p) => {
        const key = p.keyEnv ? getSecret(p.keyEnv) : null;
        return {
          id: p.id,
          label: p.label,
          authMode: p.authMode,
          keyEnv: p.keyEnv,
          state: p.authMode === 'local_endpoint' ? 'local' : key ? 'configured' : 'needs-setup',
          keyPreview: key ? redactSecret(key) : null,
        };
      });
      return json(res, 200, {
        providers,
        model: cfg.model,
        telegram: {
          enabled: cfg.channels.telegram.enabled,
          state: getSecret('TELEGRAM_BOT_TOKEN') ? 'configured' : 'needs-setup',
        },
        connectors: cfg.connectors,
        promptEngineer: cfg.promptEngineer,
      });
    }

    if (path === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      if (typeof body.key !== 'string') return json(res, 400, { error: 'key required' });
      // Guardrail: only whitelisted keys are settable from the UI.
      const allowed = [
        'model.provider',
        'model.model',
        'channels.telegram.enabled',
        'connectors.claudeCode.enabled',
        // 'connectors.claudeCode.autonomy' is deliberately NOT web-settable:
        // switching to 'auto' (bypassPermissions) requires a host-side config
        // edit, keeping that escalation out of band from the web UI.
        'connectors.openDesign.enabled',
        'connectors.openDesign.baseUrl',
        'promptEngineer.enabled',
        'daemon.publicUrl',
      ];
      if (!allowed.includes(body.key)) return json(res, 400, { error: 'key not allowed' });
      setConfigValue(body.key, body.value);
      audit('config-change', { key: body.key });
      return json(res, 200, { ok: true });
    }

    if (path === '/api/secret' && req.method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name ?? '');
      const value = String(body.value ?? '');
      const allowedSecrets = [
        'ANTHROPIC_API_KEY',
        'OPENAI_API_KEY',
        'OPENROUTER_API_KEY',
        'GEMINI_API_KEY',
        'XAI_API_KEY',
        'TELEGRAM_BOT_TOKEN',
      ];
      if (!allowedSecrets.includes(name)) return json(res, 400, { error: 'unknown secret' });
      if (!value) return json(res, 400, { error: 'empty value' });
      setSecret(name, value);
      audit('config-change', { secret: name });
      return json(res, 200, { ok: true });
    }

  json(res, 404, { error: 'not found' });
}

export async function startDaemon(): Promise<void> {
  const config = loadConfig();
  const server = createDaemonServer();

  server.listen(config.daemon.port, config.daemon.host, () => {
    log('daemon', `Amrita daemon on http://${config.daemon.host}:${config.daemon.port}`);
    const token = createMagicLink();
    console.log(`\n  Web UI login link (15 min):\n  ${loginUrl(token)}\n`);
  });

  // ---- channels ----
  if (config.channels.telegram.enabled) {
    const adapter = telegramAdapter();
    try {
      await adapter.start((m) => handleInbound(adapter, m));
      setCronDelivery(async (channel, chatId, text) => {
        if (channel === 'telegram') await adapter.send(chatId, { text, markdown: true });
      });
    } catch (err) {
      log('daemon', `telegram failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ---- background work ----
  startScheduler();
  setInterval(() => {
    summarizeIdleSessions().catch(() => {});
  }, 10 * 60 * 1000).unref();

  const shutdown = () => {
    log('daemon', 'shutting down');
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
