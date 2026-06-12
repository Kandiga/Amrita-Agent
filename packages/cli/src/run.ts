import { AmritaKernel, defaultDbPath, ensureHome } from '@amrita/daemon';
import { CliError, InProcessClient, RpcClientError } from './client.ts';
import { COMMANDS, COMMAND_NAMES } from './commands.ts';
import { parseArgs } from './parse.ts';

export interface IO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `amrita — local client for the amritad kernel (no provider/tool execution yet)

Usage: amrita <command> [args] [--db <PATH>] [--json]

Commands:
  ${COMMAND_NAMES.join('\n  ')}

Global flags:
  --db <PATH>   SQLite database path (or :memory:)   [default: ~/.amrita/amrita.db]
  --json        emit raw JSON result/error for scripting
`;

function formatError(json: boolean, code: string, message: string, details?: unknown): string {
  if (json) {
    return JSON.stringify(
      { error: { code, message, ...(details !== undefined ? { details } : {}) } },
      null,
      2,
    );
  }
  return `error [${code}]: ${message}`;
}

/** Match `<group> <action>` then `<group>`; return the command + remaining positionals. */
function matchCommand(positionals: string[]): { key: string; rest: string[] } | null {
  if (positionals.length >= 2) {
    const two = `${positionals[0]} ${positionals[1]}`;
    if (COMMANDS[two]) return { key: two, rest: positionals.slice(2) };
  }
  const one = positionals[0];
  if (one && COMMANDS[one]) return { key: one, rest: positionals.slice(1) };
  return null;
}

/**
 * Run one CLI invocation in-process. Resolves to the process exit code (0 ok, 1
 * RPC failure, 2 usage error). Never prints a stack trace or a secret value.
 */
export async function run(argv: string[], io: IO): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const json = flags.json === true;

  if (flags.help === true || positionals.length === 0) {
    io.out(USAGE);
    return positionals.length === 0 ? 2 : 0;
  }

  const matched = matchCommand(positionals);
  if (!matched) {
    io.err(formatError(json, 'unknown_command', `unknown command: ${positionals.join(' ')}`));
    return 2;
  }

  // `--db` is optional since ADR-0024: default to the amrita home database so
  // a fresh user never has to know about database paths. The home dir is only
  // created when the default is actually used.
  let db = flags.db;
  if (typeof db !== 'string' || db.length === 0) {
    ensureHome();
    db = defaultDbPath();
  }

  const kernel = AmritaKernel.open({ dbPath: db });
  try {
    const { result, summary } = (await COMMANDS[matched.key]?.run(new InProcessClient(kernel), {
      positionals: matched.rest,
      flags,
    })) ?? { result: null, summary: '' };
    io.out(json ? JSON.stringify(result, null, 2) : summary);
    return 0;
  } catch (e) {
    if (e instanceof RpcClientError) {
      io.err(formatError(json, e.rpcCode, e.message, e.details));
      return 1;
    }
    if (e instanceof CliError) {
      io.err(formatError(json, e.code, e.message));
      return 2;
    }
    const message = e instanceof Error ? e.message : String(e);
    io.err(formatError(json, 'internal', message));
    return 1;
  } finally {
    kernel.close();
  }
}
