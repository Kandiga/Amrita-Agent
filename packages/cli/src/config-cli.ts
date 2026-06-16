/**
 * `amrita config` — the non-secret config command layer (Hermes `config`
 * parity, ADR-0026/parity-roadmap Phase D). Operates on `~/.amrita/config.json`
 * (typed `AmritaConfig.preferences`) through the daemon home helpers.
 *
 * Hard rule: secret VALUES never flow through generic config. A secret-like KEY
 * is refused (pointed at `secrets.env` / `amrita setup`); a value that *looks*
 * like a known secret token is refused too, so a benign key can't smuggle one.
 * Only env-var NAMES and non-secret flags ever live here.
 */
import {
  amritaHome,
  backupBeforeReconfigure,
  checkPermissions,
  configJsonPath,
  defaultDbPath,
  readConfig,
  secretsEnvPath,
  writeConfig,
} from '@amrita/daemon';
import { CliError } from './client.ts';

/** Substrings that mark a config key as secret-bearing — refuse to set these. */
const SECRET_KEY_SUBSTRINGS = [
  'secret',
  'token',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'api_key',
  'api-key',
  'credential',
  'privatekey',
  'private_key',
  'accesskey',
  'access_key',
  'bearer',
];

/** True when a config key name looks like it would hold a secret value. */
export function isSecretLikeKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_SUBSTRINGS.some((p) => k.includes(p));
}

/**
 * Heuristic guard: obvious secret token shapes (OpenAI/GitHub/Slack/AWS/Google/
 * bearer). Defense in depth so a benign-named key can't carry a real secret.
 */
export function looksLikeSecretValue(value: string): boolean {
  return /^(sk-|sk_|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_-]{10,}|Bearer\s)/.test(
    value.trim(),
  );
}

/** Coerce a CLI string into bool/number/string for storage (friendly typing). */
export function parseConfigValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw.trim())) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

/**
 * readConfig returns a default shell whether or not the file exists, so the
 * only honest "written yet?" signal is whether any non-default field is set.
 */
function hasConfigFile(env: NodeJS.ProcessEnv): boolean {
  const c = readConfig(env);
  return (
    c.setupComplete !== undefined || c.lastSetupAt !== undefined || c.preferences !== undefined
  );
}

export interface ConfigResult {
  result: unknown;
  summary: string;
}

/** `amrita config path` — where Amrita's home/config/secrets/db live. */
export function configPath(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const paths = {
    home: amritaHome(env),
    config: configJsonPath(env),
    secrets: secretsEnvPath(env),
    db: defaultDbPath(env),
  };
  const summary = [
    `home     ${paths.home}`,
    `config   ${paths.config}`,
    `secrets  ${paths.secrets}  (secret VALUES live here only — never in config.json or the store)`,
    `db       ${paths.db}`,
  ].join('\n');
  return { result: paths, summary };
}

/** `amrita config show` — the typed non-secret config (no secret can be here). */
export function configShow(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const config = readConfig(env);
  const summary = `${JSON.stringify(config, null, 2)}\n\nSecret values are never stored here. Set keys/tokens via \`amrita setup\` (written to secrets.env).`;
  return { result: config, summary };
}

/**
 * `amrita config set <key> <value>` — set a non-secret operator preference.
 * Refuses secret-like keys and secret-shaped values. Backs up before
 * overwriting an existing key (Hermes lesson: never mutate config without a
 * restore path).
 */
export function configSet(
  key: string | undefined,
  rawValue: string | undefined,
  stamp: string,
  env: NodeJS.ProcessEnv = process.env,
): ConfigResult {
  if (!key || rawValue === undefined) {
    throw new CliError('usage: amrita config set <key> <value>  (non-secret preferences only)');
  }
  if (isSecretLikeKey(key)) {
    throw new CliError(
      `refusing to set '${key}' through config: it looks secret-bearing. Secrets live in secrets.env (set via \`amrita setup\`); config.json holds non-secret flags only.`,
    );
  }
  if (looksLikeSecretValue(rawValue)) {
    throw new CliError(
      'refusing to set a value that looks like a secret token. Secrets belong in secrets.env via `amrita setup`, never in config.json.',
    );
  }
  const current = readConfig(env);
  const preferences = { ...(current.preferences ?? {}) };
  const overwriting = Object.hasOwn(preferences, key);
  const backups = overwriting ? backupBeforeReconfigure(stamp, env) : [];
  preferences[key] = parseConfigValue(rawValue);
  const merged = writeConfig({ preferences }, env);
  const note = overwriting ? `\n(backed up ${backups.length} file(s) before overwrite)` : '';
  return {
    result: { key, value: preferences[key], preferences: merged.preferences },
    summary: `set preferences.${key} = ${JSON.stringify(preferences[key])}${note}`,
  };
}

/** `amrita config check` — validate permissions + config readability. */
export function configCheck(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const issues = checkPermissions(env);
  const config = readConfig(env);
  const lines: string[] = [];
  lines.push(
    `config schema v${config.version} · ${hasConfigFile(env) ? 'present' : 'defaults (not written yet)'}`,
  );
  if (issues.length === 0) {
    lines.push('permissions: ok (home 0700, secrets/config 0600)');
  } else {
    for (const i of issues) {
      lines.push(
        `permissions: ${i.label} is ${i.actualMode.toString(8)} (want ${i.expectedMode.toString(8)}) — ${i.path}`,
      );
    }
    lines.push('fix: amrita doctor --fix');
  }
  return {
    result: { ok: issues.length === 0, version: config.version, issues },
    summary: lines.join('\n'),
  };
}
