#!/usr/bin/env node
import { run } from '../run.ts';

/**
 * `amrita` — local CLI for the amritad kernel. Speaks RPC in-process against a
 * DB given by `--db`. Exit code: 0 ok, 1 RPC failure, 2 usage error.
 *
 *   amrita health --db ~/.amrita/amrita.db
 *   amrita project ensure crm --name "Secure CRM" --db ~/.amrita/amrita.db
 */
const code = run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
