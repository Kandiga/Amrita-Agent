#!/usr/bin/env node
import { resolveAuthToken } from '../auth.ts';
import { defaultDbPath, ensureHome, loadSecretsEnv } from '../home.ts';
import { startHttpServer } from '../http.ts';
import { AmritaKernel } from '../kernel.ts';
import { createStdioServer } from '../stdio.ts';

/**
 * `amritad` — serve the kernel over JSON-lines stdio (default) or HTTP/WS.
 *
 *   amritad                                          # stdio, ~/.amrita/amrita.db
 *   echo '{"id":1,"method":"ping"}' | amritad --db :memory:
 *   amritad --http --port 7460                       # HTTP + WS on localhost
 *   amritad --http --port 0                          # OS-assigned port (printed)
 *
 * HTTP mode requires a bearer token on every route except `GET /health`. Set
 * `AMRITA_AUTH_TOKEN` to choose it, or the daemon generates an ephemeral one and
 * prints it once at startup (never to a file).
 */
interface Args {
  dbPath: string | null;
  http: boolean;
  port: number;
  telegram: boolean;
  scheduler: boolean;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { dbPath: null, http: false, port: 7460, telegram: false, scheduler: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--db' || a === '-d') && argv[i + 1]) {
      args.dbPath = argv[++i] as string;
    } else if (a?.startsWith('--db=')) {
      args.dbPath = a.slice('--db='.length);
    } else if (a === '--http') {
      args.http = true;
    } else if (a === '--telegram') {
      args.telegram = true;
    } else if (a === '--scheduler') {
      args.scheduler = true;
    } else if (a === '--port' && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (a?.startsWith('--port=')) {
      args.port = Number(a.slice('--port='.length));
    }
  }
  return args;
}

/**
 * Last-resort process guards. A stray rejection (a detached lane promise, a
 * background probe) or a non-fatal throw must never take the daemon down with a
 * raw stack. Logged VALUE-FREE (message only, never the error object, which could
 * carry a secret) so the daemon keeps serving. A genuinely fatal listen/DB error
 * still exits deliberately via its own path.
 */
function installProcessGuards(): void {
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : 'non-error rejection';
    process.stderr.write(`amritad: unhandled rejection (ignored, still serving): ${msg}\n`);
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`amritad: uncaught exception (ignored, still serving): ${err.message}\n`);
  });
}

async function main(): Promise<void> {
  installProcessGuards();
  // Machine-local secrets file (ADR-0024): fills unset env vars (provider keys,
  // telegram token) before anything reads them. Real process env always wins.
  loadSecretsEnv();

  const args = parseArgs(process.argv.slice(2));
  let dbPath = args.dbPath;
  if (dbPath === null) {
    ensureHome();
    dbPath = defaultDbPath();
  }
  const { http, port, telegram, scheduler } = args;
  let kernel: AmritaKernel;
  try {
    kernel = AmritaKernel.open({ dbPath });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`amritad: could not open the database at ${dbPath}: ${message}\n`);
    process.exit(1);
  }

  // ADR-0049: re-attach to any interactive tmux session that survived the restart
  // (or honestly abort the ones whose session is gone). Best-effort — a probe hiccup
  // must never stop the daemon from serving.
  kernel
    .resumeTmuxSessions()
    .then(({ resumed, aborted }) => {
      if (resumed || aborted) {
        process.stdout.write(`amritad: sessions resumed ${resumed}, aborted ${aborted}\n`);
      }
    })
    .catch(() => {});

  // Telegram operator runner (ADR-0021): strictly opt-in, refuses to start
  // without the token env var AND a non-empty owner allowlist. Never fakes.
  let telegramRunner: { stop(): Promise<void> } | null = null;
  if (telegram) {
    const { startTelegramRunner, parseAllowedIds } = await import('@amrita/channels');
    const allowedUserIds = parseAllowedIds(process.env.AMRITA_TELEGRAM_ALLOWED_IDS);
    try {
      telegramRunner = startTelegramRunner(kernel, { allowedUserIds });
      kernel.markChannelRunnerActive('telegram');
      process.stderr.write(
        `amritad: telegram operator runner enabled (${allowedUserIds.length} allowed id(s))\n`,
      );
    } catch (e) {
      process.stderr.write(
        `amritad: telegram runner NOT started — ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // Minimal typed scheduler (ADR-0036): opt-in; silent-on-success watchdog.
  let runningScheduler: { stop(): Promise<void> } | null = null;
  if (scheduler) {
    const { Scheduler } = await import('../scheduler.ts');
    const s = new Scheduler(kernel);
    kernel.attachScheduler(s);
    s.start();
    runningScheduler = s;
    process.stderr.write('amritad: scheduler enabled (system-health watchdog, hourly)\n');
  }

  // Make lane execution posture visible at startup (never silently real). On
  // stdio it goes to stderr so it cannot corrupt the JSON-lines protocol.
  const laneStatus = `amritad: lanes real-execution ${
    kernel.realLaneExecution ? 'ENABLED (AMRITA_LANES_ALLOW_REAL_EXECUTION)' : 'disabled'
  }\n`;

  if (http) {
    const auth = resolveAuthToken(process.env.AMRITA_AUTH_TOKEN);
    let running: Awaited<ReturnType<typeof startHttpServer>>;
    try {
      running = await startHttpServer(kernel, { port, authToken: auth.token });
    } catch (err) {
      // A bind failure is fatal but must be HONEST, not a raw stack trace. The
      // common case (port already taken by a previous instance) gets a plain line.
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      const why =
        code === 'EADDRINUSE'
          ? `port ${port} is already in use — another amritad is probably running`
          : code === 'EACCES'
            ? `not allowed to bind port ${port}`
            : `could not start the HTTP server (${code})`;
      process.stderr.write(`amritad: ${why}\n`);
      kernel.close();
      process.exit(1);
    }
    process.stdout.write(`amritad http listening on http://${running.host}:${running.port}\n`);
    if (auth.source === 'generated') {
      // Printed once, to stdout only — never written to a file or an event.
      process.stdout.write(
        `amritad: auth enabled with a generated token (set AMRITA_AUTH_TOKEN to override):\n  ${auth.token}\n`,
      );
    } else {
      process.stdout.write('amritad: auth enabled via AMRITA_AUTH_TOKEN\n');
    }
    process.stdout.write(laneStatus);
    const shutdown = (): void => {
      void Promise.all([
        telegramRunner?.stop() ?? Promise.resolve(),
        runningScheduler?.stop() ?? Promise.resolve(),
      ]).then(() =>
        running.close().then(() => {
          kernel.close();
          process.exit(0);
        }),
      );
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  process.stderr.write(laneStatus);
  createStdioServer(kernel, { onClose: () => kernel.close() });
}

void main().catch((err) => {
  // Last-resort: never let a startup failure surface as an unhandled rejection.
  process.stderr.write(`amritad: fatal startup error: ${(err as Error).message}\n`);
  process.exit(1);
});
