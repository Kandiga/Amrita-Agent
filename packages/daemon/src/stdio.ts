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

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write({ id: null, error: { code: 'invalid_request', message: 'invalid JSON' } });
      return;
    }
    write(dispatch(kernel, parsed));
  });

  rl.once('close', () => {
    opts.onClose?.();
  });

  return { close: () => rl.close() };
}
