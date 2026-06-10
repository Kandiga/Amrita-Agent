#!/usr/bin/env node
import { AmritaKernel } from '../kernel.ts';
import { createStdioServer } from '../stdio.ts';

/**
 * `amritad` — start the kernel and serve JSON-lines RPC on stdio until stdin
 * closes. No provider calls, no tool execution (WO#2.1). Usage:
 *
 *   amritad --db ~/.amrita/amrita.db
 *   echo '{"id":1,"method":"ping"}' | amritad --db :memory:
 */
function parseArgs(argv: string[]): { dbPath: string } {
  let dbPath = ':memory:';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' || a === '-d') {
      const next = argv[i + 1];
      if (!next) throw new Error('--db requires a path');
      dbPath = next;
      i++;
    } else if (a?.startsWith('--db=')) {
      dbPath = a.slice('--db='.length);
    }
  }
  return { dbPath };
}

function main(): void {
  const { dbPath } = parseArgs(process.argv.slice(2));
  const kernel = AmritaKernel.open({ dbPath });
  createStdioServer(kernel, {
    onClose: () => {
      kernel.close();
    },
  });
}

main();
