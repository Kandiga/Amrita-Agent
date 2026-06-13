import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  amritaHome,
  backupBeforeReconfigure,
  checkPermissions,
  configJsonPath,
  defaultDbPath,
  ensureHome,
  fixPermissions,
  loadSecretsEnv,
  parseEnvFile,
  readConfig,
  secretsEnvPath,
  validEnvName,
  writeConfig,
  writeSecretsEnv,
} from '../src/home.ts';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-home-'));
  env = { AMRITA_HOME: join(dir, '.amrita') };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('amrita home paths (ADR-0024)', () => {
  it('AMRITA_HOME overrides the default; db and secrets paths live inside it', () => {
    expect(amritaHome(env)).toBe(join(dir, '.amrita'));
    expect(defaultDbPath(env)).toBe(join(dir, '.amrita', 'amrita.db'));
    expect(secretsEnvPath(env)).toBe(join(dir, '.amrita', 'secrets.env'));
  });

  it('ensureHome creates the directory owner-only (0700) and is idempotent', () => {
    const home = ensureHome(env);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(ensureHome(env)).toBe(home);
  });
});

describe('env file parsing', () => {
  it('parses KEY=value, ignores comments/blank/invalid lines, tolerates CRLF', () => {
    const parsed = parseEnvFile(
      '# comment\n\nANTHROPIC_API_KEY=sk-test-123\r\nlowercase=skipped\nNOEQUALS\nA_B=with=equals\n',
    );
    expect(parsed).toEqual({ ANTHROPIC_API_KEY: 'sk-test-123', A_B: 'with=equals' });
  });

  it('validates env names as UPPER_SNAKE', () => {
    expect(validEnvName('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(validEnvName('1BAD')).toBe(false);
    expect(validEnvName('bad')).toBe(false);
    expect(validEnvName('')).toBe(false);
  });
});

describe('writeSecretsEnv', () => {
  it('writes 0600, merges on re-write, and forces single-line values', () => {
    const path = writeSecretsEnv({ ANTHROPIC_API_KEY: 'one' }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    writeSecretsEnv({ TELEGRAM_BOT_TOKEN: 'two\nstray-line' }, env);
    const parsed = parseEnvFile(readFileSync(path, 'utf8'));
    expect(parsed).toEqual({ ANTHROPIC_API_KEY: 'one', TELEGRAM_BOT_TOKEN: 'two stray-line' });
    expect(existsSync(`${path}.tmp`)).toBe(false); // atomic: no tmp residue
  });

  it('rejects invalid names', () => {
    expect(() => writeSecretsEnv({ 'bad-name': 'x' }, env)).toThrow(/invalid env var name/);
  });
});

describe('loadSecretsEnv', () => {
  it('fills unset vars only — real process env always wins — and returns names', () => {
    writeSecretsEnv({ ANTHROPIC_API_KEY: 'from-file', ALREADY_SET: 'from-file' }, env);
    env.ALREADY_SET = 'from-process';
    const applied = loadSecretsEnv(env);
    expect(applied).toEqual(['ANTHROPIC_API_KEY']);
    expect(env.ANTHROPIC_API_KEY).toBe('from-file');
    expect(env.ALREADY_SET).toBe('from-process');
  });

  it('is a silent no-op when the file does not exist', () => {
    expect(loadSecretsEnv(env)).toEqual([]);
  });
});

describe('typed config (ADR-0026)', () => {
  it('reads a default shell when absent, then round-trips merged writes', () => {
    expect(readConfig(env)).toEqual({ version: 1 });
    writeConfig({ setupComplete: true, lastSetupAt: '2026-06-13T00:00:00Z' }, env);
    const after = readConfig(env);
    expect(after.setupComplete).toBe(true);
    expect(after.lastSetupAt).toBe('2026-06-13T00:00:00Z');
    // merge: a later partial write keeps prior fields
    writeConfig({ preferences: { theme: 'dark' } }, env);
    const merged = readConfig(env);
    expect(merged.setupComplete).toBe(true);
    expect(merged.preferences).toEqual({ theme: 'dark' });
  });

  it('config file is written 0600', () => {
    writeConfig({ setupComplete: true }, env);
    expect(statSync(configJsonPath(env)).mode & 0o777).toBe(0o600);
  });

  it('tolerates a corrupt config file (returns defaults, never throws)', () => {
    ensureHome(env);
    writeFileSync(configJsonPath(env), 'not json{', { mode: 0o600 });
    expect(readConfig(env)).toEqual({ version: 1 });
  });
});

describe('backupBeforeReconfigure', () => {
  it('copies existing config + secrets to timestamped .bak files, 0600', () => {
    writeSecretsEnv({ ANTHROPIC_API_KEY: 'x' }, env);
    writeConfig({ setupComplete: true }, env);
    const written = backupBeforeReconfigure('2026-06-13T00-00-00Z', env);
    expect(written).toHaveLength(2);
    for (const p of written) {
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('is a no-op when nothing exists yet', () => {
    expect(backupBeforeReconfigure('stamp', env)).toEqual([]);
  });
});

describe('permission checks', () => {
  it('flags a loose secrets file and fixes it', () => {
    writeSecretsEnv({ ANTHROPIC_API_KEY: 'x' }, env);
    chmodSync(secretsEnvPath(env), 0o644); // loosen
    const issues = checkPermissions(env);
    expect(issues.some((i) => i.label === 'secrets file')).toBe(true);
    const fixed = fixPermissions(env);
    expect(fixed).toContain(secretsEnvPath(env));
    expect(checkPermissions(env)).toEqual([]);
  });

  it('a fresh 0700 home with no files has no issues', () => {
    ensureHome(env);
    expect(checkPermissions(env)).toEqual([]);
  });
});
