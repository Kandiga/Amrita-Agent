import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The Amrita home directory (`~/.amrita`, override with `AMRITA_HOME`): the
 * machine-local runtime home for the default database and the secrets env
 * file. Nothing here is ever synced, committed, or read into the store —
 * the store keeps env-var NAMES only (ADR-0024).
 */
export function amritaHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AMRITA_HOME;
  return override && override.length > 0 ? override : join(homedir(), '.amrita');
}

/** Default SQLite database path used when the CLI/daemon get no `--db`. */
export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(amritaHome(env), 'amrita.db');
}

/** Path of the machine-local secrets env file (created by `amrita setup`). */
export function secretsEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(amritaHome(env), 'secrets.env');
}

/** Create the home directory owner-only (0700). Idempotent. */
export function ensureHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = amritaHome(env);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Whether `name` is a valid env-var name for the secrets file (UPPER_SNAKE). */
export function validEnvName(name: string): boolean {
  return ENV_NAME_RE.test(name);
}

/**
 * Parse a `KEY=value` env file. Blank lines and `#` comments are ignored;
 * lines with invalid names or no `=` are skipped (never fatal — a hand-edited
 * file must not brick startup). Values are single-line by construction.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!validEnvName(name)) continue;
    out[name] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Load `~/.amrita/secrets.env` into `process.env`. Real process env always
 * wins — the file only fills variables that are unset. Returns the NAMES that
 * were applied (names only; values are never returned or logged). Missing
 * file is a silent no-op.
 */
export function loadSecretsEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const path = secretsEnvPath(env);
  if (!existsSync(path)) return [];
  const parsed = parseEnvFile(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value;
      applied.push(name);
    }
  }
  return applied;
}

/**
 * Merge `updates` into the secrets env file atomically (tmp + rename, 0600).
 * Values are forced single-line (newlines → spaces) so a pasted secret can
 * never split into stray lines. Invalid names throw. Returns the file path.
 */
export function writeSecretsEnv(
  updates: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of Object.keys(updates)) {
    if (!validEnvName(name)) throw new Error(`invalid env var name: ${name}`);
  }
  const path = secretsEnvPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const current = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {};
  for (const [name, value] of Object.entries(updates)) {
    current[name] = value.replace(/[\r\n]+/g, ' ').trim();
  }
  const body = `${Object.entries(current)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600); // rename preserves the tmp mode, but be explicit
  return path;
}
