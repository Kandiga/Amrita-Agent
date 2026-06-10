import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AmritaKernel } from './kernel.ts';
import { type RpcResponse, dispatch } from './rpc.ts';

export interface StdioServerOptions {
  input?: Readable;
  output?: Writable;
  /** Called after the input stream ends (e.g. to close the kernel). */
  onClose?: () => void;
}

/**
 * A JSON-lines stdio server: one request object per input line, one response
 * object per output line. Blank lines are ignored; unparseable lines get an
 * `invalid_request` response rather than crashing the loop. Suitable for a CLI
 * client and for in-process tests (pass any Readable/Writable).
 */
export function createStdioServer(
  kernel: AmritaKernel,
  opts: StdioServerOptions = {},
): { close: () => void } {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  const write = (resp: RpcResponse): void => {
    output.write(`${JSON.stringify(resp)}\n`);
  };

  // Process lines strictly in order even though dispatch is async: each line
  // chains off the previous so responses are emitted in request order.
  let chain: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        write({ id: null, error: { code: 'invalid_request', message: 'invalid JSON' } });
        return;
      }
      write(await dispatch(kernel, parsed));
    });
  });

  // Run onClose only after every queued request has been answered.
  rl.once('close', () => {
    void chain.then(() => opts.onClose?.());
  });

  return { close: () => rl.close() };
}
