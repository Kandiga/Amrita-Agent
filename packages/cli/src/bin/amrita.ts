#!/usr/bin/env node
import { loadSecretsEnv } from '@amrita/daemon';
import { run } from '../run.ts';

/**
 * `amrita` — local CLI for the amritad kernel. Speaks RPC in-process against a
 * DB given by `--db` (default `~/.amrita/amrita.db`). Exit code: 0 ok, 1 RPC
 * failure, 2 usage error.
 *
 *   amrita setup
 *   amrita health
 *   amrita project ensure crm --name "Secure CRM"
 */
// Machine-local secrets file (ADR-0024). Real process env always wins; the
// file only fills unset variables, and only at the executable boundary so
// in-process tests stay hermetic.
loadSecretsEnv();

const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
process.exitCode = code;
