#!/usr/bin/env node
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
 */
interface Args {
  dbPath: string;
  http: boolean;
  port: number;
}
function parseArgs(argv: string[]): Args {
  const args: Args = { dbPath: ':memory:', http: false, port: 7460 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--db' || a === '-d') && argv[i + 1]) {
      args.dbPath = argv[++i] as string;
    } else if (a?.startsWith('--db=')) {
      args.dbPath = a.slice('--db='.length);
    } else if (a === '--http') {
      args.http = true;
    } else if (a === '--port' && argv[i + 1]) {
      args.port = Number(argv[++i]);
    } else if (a?.startsWith('--port=')) {
      args.port = Number(a.slice('--port='.length));
    }
  }
  return args;
}

async function main(): Promise<void> {
  const { dbPath, http, port } = parseArgs(process.argv.slice(2));
  const kernel = AmritaKernel.open({ dbPath });

  if (http) {
    const running = await startHttpServer(kernel, { port });
    process.stdout.write(`amritad http listening on http://${running.host}:${running.port}\n`);
    const shutdown = (): void => {
      void running.close().then(() => {
        kernel.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  createStdioServer(kernel, { onClose: () => kernel.close() });
}

void main();
