import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AmritaKernel, parseEnvFile, secretsEnvPath } from '@amrita/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, InProcessClient } from '../src/client.ts';
import { type ProbeFetch, type SetupDeps, runSetupWizard } from '../src/setup.ts';

let dir: string;
let kernel: AmritaKernel;
let client: InProcessClient;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-setup-'));
  process.env.AMRITA_HOME = join(dir, '.amrita');
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  client = new InProcessClient(kernel);
});
afterEach(() => {
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
  for (const name of [
    'AMRITA_HOME',
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'AMRITA_TELEGRAM_ALLOWED_IDS',
  ]) {
    delete process.env[name]; // deterministic env posture between tests
  }
});

const telegramOk: ProbeFetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ ok: true, result: { username: 'amrita_test_bot' } }),
});
const telegramFail: ProbeFetch = async () => ({
  ok: false,
  status: 401,
  json: async () => ({ ok: false }),
});

/** Scripted deps: answers/secrets consumed in order; output captured. */
function scripted(
  answers: string[],
  secrets: string[],
  fetchImpl: ProbeFetch,
): { deps: SetupDeps; output: () => string } {
  const lines: string[] = [];
  const a = [...answers];
  const s = [...secrets];
  return {
    deps: {
      ask: async (q) => {
        const next = a.shift();
        if (next === undefined) throw new Error(`wizard asked beyond script: ${q}`);
        return next;
      },
      askSecret: async (q) => {
        const next = s.shift();
        if (next === undefined) throw new Error(`wizard asked secret beyond script: ${q}`);
        return next;
      },
      out: (line) => {
        lines.push(line);
      },
      fetchImpl,
      env: process.env,
    },
    output: () => lines.join('\n'),
  };
}

interface AccountLite {
  id: string;
  provider: string;
  secretRef: string | null;
}

describe('amrita setup wizard (ADR-0024)', () => {
  it('full flow: provider key + telegram — secrets to file, names to store, role bound', async () => {
    // answers: provider choice, enable telegram, allowed ids
    const { deps, output } = scripted(
      ['1', 'y', '12345, 678'],
      ['sk-test-abc', 'tok-tg'],
      telegramOk,
    );
    await runSetupWizard(client, deps);

    // secrets file: 0600, both values present, single source of truth
    const path = secretsEnvPath(process.env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parseEnvFile(readFileSync(path, 'utf8'))).toEqual({
      ANTHROPIC_API_KEY: 'sk-test-abc',
      TELEGRAM_BOT_TOKEN: 'tok-tg',
      AMRITA_TELEGRAM_ALLOWED_IDS: '12345,678',
    });

    // store: env NAME only, never the value
    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider).toBe('anthropic');
    expect(accounts[0]?.secretRef).toBe('ANTHROPIC_API_KEY');
    expect(JSON.stringify(accounts)).not.toContain('sk-test-abc');

    // role main → anthropic
    const roles = await client.call<{ roles: { role: string; resolvesTo: string }[] }>(
      'providers.roles',
    );
    expect(roles.roles.find((r) => r.role === 'main')?.resolvesTo).toBe('anthropic');

    const text = output();
    expect(text).toContain('env ready');
    expect(text).toContain('@amrita_test_bot');
    expect(text).not.toContain('sk-test-abc'); // wizard output is value-free
    expect(text).not.toContain('tok-tg');
  });

  it('re-running is idempotent: keeps the existing key and the single account', async () => {
    const first = scripted(['1', 'n'], ['sk-test-abc'], telegramOk);
    await runSetupWizard(client, first.deps);

    // second run: key already in env → no secret prompt for provider;
    // telegram unconfigured → asks enable, declined
    const second = scripted(['1', 'n'], [], telegramOk);
    await runSetupWizard(client, second.deps);
    expect(second.output()).toContain('already set');

    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts).toHaveLength(1);
  });

  it('a failing telegram probe is honest, and declining keeps the file clean', async () => {
    const { deps, output } = scripted(['0', 'y', 'n'], ['bad-token'], telegramFail);
    await runSetupWizard(client, deps);
    expect(output()).toContain('did NOT verify');
    const path = secretsEnvPath(process.env);
    let saved: Record<string, string> = {};
    try {
      saved = parseEnvFile(readFileSync(path, 'utf8'));
    } catch {
      // no file at all is equally clean
    }
    expect(saved.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it('skipping the provider creates no account and keeps mock working', async () => {
    const { deps, output } = scripted(['0', 'n'], [], telegramOk);
    await runSetupWizard(client, deps);
    expect(output()).toContain('mock provider');
    expect(await client.call<AccountLite[]>('accounts.list')).toEqual([]);
  });

  it('rejects non-numeric telegram allowlist ids with a clear error', async () => {
    const { deps } = scripted(['0', 'y', 'not-a-number'], ['tok'], telegramOk);
    await expect(runSetupWizard(client, deps)).rejects.toThrow(CliError);
  });
});
