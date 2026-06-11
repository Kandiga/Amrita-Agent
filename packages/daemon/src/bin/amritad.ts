#!/usr/bin/env node
import { resolveAuthToken } from '../auth.ts';
import { startHttpServer } from '../http.ts';
import { AmritaKernel } from '../kernel.ts';
import { createStdioServer } from '../stdio.ts';

/**
 * `amritad` — serve the kernel over JSON-lines stdio (default) or HTTP/WS.
 *
 *   amritad --db ~/.amrita/amrita.db                 # stdio JSON-RPC
 *   echo '{"id":1,"method":"ping"}' | amritad --db :memory:
 *   amritad --db ~/.amrita/amrita.db --http --port 7460   # HTTP + WS on localhost
 *   amritad --http --port 0                          # OS-assigned port (printed)
 *
 * HTTP mode requires a bearer token on every route except `GET /health`. Set
 * `AMRITA_AUTH_TOKEN` to choose it, or the daemon generates an ephemeral one and
 * prints it once at startup (never to a file).
 */
interface Args {
  dbPath: string;
  http: boolean;
  port: number;
  telegram: boolean;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { dbPath: ':memory:', http: false, port: 7460, telegram: false };
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
    } else if (a === '--port' && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (a?.startsWith('--port=')) {
      args.port = Number(a.slice('--port='.length));
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { dbPath, http, port, telegram } = parseArgs(process.argv.slice(2));
  const kernel = AmritaKernel.open({ dbPath });

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

  // Make lane execution posture visible at startup (never silently real). On
  // stdio it goes to stderr so it cannot corrupt the JSON-lines protocol.
  const laneStatus = `amritad: lanes real-execution ${
    kernel.realLaneExecution ? 'ENABLED (AMRITA_LANES_ALLOW_REAL_EXECUTION)' : 'disabled'
  }\n`;

  if (http) {
    const auth = resolveAuthToken(process.env.AMRITA_AUTH_TOKEN);
    const running = await startHttpServer(kernel, { port, authToken: auth.token });
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
      void (telegramRunner?.stop() ?? Promise.resolve()).then(() =>
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

void main();
