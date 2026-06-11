/** Boolean flags take no value; everything else `--flag value` (or `--flag=value`). */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'dry-run', 'real']);

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** A tiny, dependency-free argv parser. Unknown `--flags` consume the next token. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    // a bare `--` is pnpm's script/args separator (`pnpm amrita -- doctor ...`) — skip it,
    // otherwise it reads as an empty flag that swallows the command word
    if (a === '--') continue;
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      const key = eq >= 0 ? body.slice(0, eq) : body;
      const inline = eq >= 0 ? body.slice(eq + 1) : undefined;
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (inline !== undefined) {
        flags[key] = inline;
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

/** Read a string flag, throwing a clear message when required and absent. */
export function strFlag(flags: ParsedArgs['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}
