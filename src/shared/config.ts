import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { AmritaConfig } from './types.ts';
import { paths, ensureHome } from './paths.ts';

export const defaultConfig: AmritaConfig = {
  model: { provider: 'anthropic', model: 'claude-sonnet-4-6', maxTokens: 8192 },
  auxiliary: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  fallback: [],
  providers: {},
  channels: { telegram: { enabled: false } },
  daemon: { host: '127.0.0.1', port: 7460, publicUrl: null },
  agent: { maxTurns: 24, contextTokenBudget: 24_000 },
  toolsets: { disabled: [] },
  connectors: {
    claudeCode: { enabled: true, autonomy: 'ask' },
    openDesign: { enabled: false, baseUrl: 'http://127.0.0.1:7456' },
  },
  promptEngineer: { enabled: true },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const baseVal = (base as Record<string, unknown> | null)?.[k];
    out[k] =
      baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)
        ? deepMerge(baseVal, v)
        : v;
  }
  return out as T;
}

let cached: AmritaConfig | null = null;

export function loadConfig(force = false): AmritaConfig {
  if (cached && !force) return cached;
  ensureHome();
  if (!existsSync(paths.config())) {
    cached = structuredClone(defaultConfig);
    return cached;
  }
  const raw = JSON.parse(readFileSync(paths.config(), 'utf8'));
  cached = deepMerge(structuredClone(defaultConfig), raw);
  return cached;
}

export function saveConfig(config: AmritaConfig): void {
  ensureHome();
  writeFileSync(paths.config(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  cached = config;
}

/** Set a dotted key, e.g. "model.model" = "claude-opus-4-8". */
export function setConfigValue(key: string, value: unknown): AmritaConfig {
  const config = loadConfig(true);
  const parts = key.split('.');
  let node: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
  saveConfig(config);
  return config;
}

// ---------- secrets.env ----------

/** Parse KEY=value lines (no shell expansion). Values stay out of logs. */
export function loadSecrets(): Record<string, string> {
  const file = paths.secrets();
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
}

export function getSecret(name: string): string | null {
  return process.env[name] ?? loadSecrets()[name] ?? null;
}

export function setSecret(name: string, value: string): void {
  ensureHome();
  const file = paths.secrets();
  const lines = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
    : [];
  const filtered = lines.filter((l) => !l.trim().startsWith(`${name}=`));
  filtered.push(`${name}=${value}`);
  writeFileSync(file, filtered.join('\n') + '\n', { mode: 0o600 });
}

/** "sk-…abc" shape for safe display. Never log full secrets. */
export function redactSecret(value: string): string {
  if (value.length <= 8) return '****';
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}
