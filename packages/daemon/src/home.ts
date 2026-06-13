import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** Path of the typed non-secret config file (ADR-0026). */
export function configJsonPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(amritaHome(env), 'config.json');
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

// ── typed non-secret config (ADR-0026) ──────────────────────────────────────

/**
 * Amrita's typed, non-secret config file (`~/.amrita/config.json`). Holds
 * settings that benefit from living outside the DB (operator preferences the
 * installer/wizard read before a kernel is open). Secret VALUES never go here —
 * only names/flags. Written atomically (tmp + rename) at 0600.
 */
export interface AmritaConfig {
  /** Schema version for forward-compatible migrations. */
  version: number;
  /** ISO timestamp of the last `amrita setup` completion. */
  lastSetupAt?: string;
  /** Whether first-run setup has completed at least once. */
  setupComplete?: boolean;
  /** Free-form non-secret operator preferences (typed at the edges). */
  preferences?: Record<string, unknown>;
}

const CONFIG_VERSION = 1;

/** Read the config file, returning a default shell when absent or unparseable. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AmritaConfig {
  const path = configJsonPath(env);
  if (!existsSync(path)) return { version: CONFIG_VERSION };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return { version: CONFIG_VERSION };
    const obj = parsed as Record<string, unknown>;
    return {
      version: typeof obj.version === 'number' ? obj.version : CONFIG_VERSION,
      ...(typeof obj.lastSetupAt === 'string' ? { lastSetupAt: obj.lastSetupAt } : {}),
      ...(typeof obj.setupComplete === 'boolean' ? { setupComplete: obj.setupComplete } : {}),
      ...(obj.preferences && typeof obj.preferences === 'object'
        ? { preferences: obj.preferences as Record<string, unknown> }
        : {}),
    };
  } catch {
    return { version: CONFIG_VERSION };
  }
}

/** Merge `updates` into the config file atomically (tmp + rename, 0600). */
export function writeConfig(
  updates: Partial<AmritaConfig>,
  env: NodeJS.ProcessEnv = process.env,
): AmritaConfig {
  const path = configJsonPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const merged: AmritaConfig = { ...readConfig(env), ...updates, version: CONFIG_VERSION };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return merged;
}

/**
 * Back up config.json and secrets.env to timestamped `.bak.<stamp>` copies before
 * a reconfigure (Hermes lesson: never mutate a customized config without a
 * restore path). `stamp` is injected (callers pass a real timestamp; tests pass
 * a fixed one) so this stays deterministic. Returns the paths written.
 */
export function backupBeforeReconfigure(
  stamp: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const written: string[] = [];
  for (const src of [configJsonPath(env), secretsEnvPath(env)]) {
    if (!existsSync(src)) continue;
    const dest = `${src}.bak.${stamp}`;
    try {
      copyFileSync(src, dest);
      chmodSync(dest, 0o600);
      written.push(dest);
    } catch {
      // a failed backup must not block reconfigure — best effort
    }
  }
  return written;
}

// ── permission checks (Hermes doctor lesson: home 0700, secrets 0600) ────────

export interface PermissionIssue {
  path: string;
  expectedMode: number;
  actualMode: number;
  label: string;
}

/** Report home/secrets/config paths whose permissions are looser than required. */
export function checkPermissions(env: NodeJS.ProcessEnv = process.env): PermissionIssue[] {
  const issues: PermissionIssue[] = [];
  const targets: { path: string; mode: number; label: string }[] = [
    { path: amritaHome(env), mode: 0o700, label: 'home directory' },
    { path: secretsEnvPath(env), mode: 0o600, label: 'secrets file' },
    { path: configJsonPath(env), mode: 0o600, label: 'config file' },
  ];
  for (const t of targets) {
    if (!existsSync(t.path)) continue;
    const actual = statSync(t.path).mode & 0o777;
    // Looser than required = any bit set beyond the allowed mask.
    if ((actual & ~t.mode) !== 0) {
      issues.push({ path: t.path, expectedMode: t.mode, actualMode: actual, label: t.label });
    }
  }
  return issues;
}

/** Tighten any loose permissions found by checkPermissions. Returns fixed paths. */
export function fixPermissions(env: NodeJS.ProcessEnv = process.env): string[] {
  const fixed: string[] = [];
  for (const issue of checkPermissions(env)) {
    try {
      chmodSync(issue.path, issue.expectedMode);
      fixed.push(issue.path);
    } catch {
      // best effort — doctor reports what could not be fixed
    }
  }
  return fixed;
}
