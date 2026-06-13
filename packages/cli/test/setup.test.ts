import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AmritaKernel,
  type FetchLike,
  type FetchResponseLike,
  parseEnvFile,
  secretsEnvPath,
} from '@amrita/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError, InProcessClient } from '../src/client.ts';
import {
  type ProbeFetch,
  SETUP_SECTION_IDS,
  type SetupDeps,
  runSetupWizard,
} from '../src/setup.ts';

/** A fake /models fetch so local-endpoint discovery is deterministic. */
function fakeModels(ids: string[]): FetchLike {
  return async (): Promise<FetchResponseLike> => ({
    ok: true,
    status: 200,
    async json() {
      return { data: ids.map((id) => ({ id })) };
    },
    async text() {
      return '';
    },
  });
}

let dir: string;
let kernel: AmritaKernel;
let client: InProcessClient;

/** Fake CLI prober: tests choose which CLIs "exist"/"are logged in". */
function prober(opts: { claude?: 'ready' | 'logged_out' | 'missing'; codex?: boolean }) {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'claude') {
      if (opts.claude === 'missing' || !opts.claude) return { kind: 'spawn_error' as const };
      if (args[0] === '--version') return { kind: 'ok' as const, stdout: '2.1.0 (Claude Code)' };
      return opts.claude === 'ready'
        ? { kind: 'ok' as const, stdout: 'logged in' }
        : { kind: 'failed' as const, stdout: '' };
    }
    if (cmd === 'codex' && opts.codex) return { kind: 'ok' as const, stdout: '1.0.0' };
    return { kind: 'spawn_error' as const };
  };
}

function openKernel(
  opts: {
    claude?: 'ready' | 'logged_out' | 'missing';
    codex?: boolean;
    fetchImpl?: FetchLike;
  } = {},
) {
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    codingRuntimeProber: prober(opts),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  client = new InProcessClient(kernel);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-setup-'));
  process.env.AMRITA_HOME = join(dir, '.amrita');
  openKernel(); // default: no CLIs found — pure API-key world
});
afterEach(() => {
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
  for (const name of [
    'AMRITA_HOME',
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'AMRITA_TELEGRAM_ALLOWED_IDS',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'LOCAL_LLM_API_KEY',
    'AMRITA_LANES_ALLOW_REAL_EXECUTION',
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
    // answers: provider choice (3 = anthropic), model (default), telegram, ids
    const { deps, output } = scripted(
      ['3', '', 'y', '12345, 678'],
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
    const first = scripted(['3', '', 'n'], ['sk-test-abc'], telegramOk);
    await runSetupWizard(client, first.deps);

    // second run: key already in env → no secret prompt for provider;
    // telegram unconfigured → asks enable, declined
    const second = scripted(['3', '', 'n'], [], telegramOk);
    await runSetupWizard(client, second.deps);
    expect(second.output()).toContain('already set');

    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts).toHaveLength(1);
  });

  it('renders the full grouped catalog with honest per-provider states', async () => {
    const { deps, output } = scripted(['0', 'n'], [], telegramOk);
    await runSetupWizard(client, deps);
    const text = output();
    expect(text).toContain('Subscription / login');
    expect(text).toContain('API key');
    expect(text).toContain('Local / self-hosted');
    for (const title of [
      'Claude subscription (via Claude Code login)',
      'OpenAI account (via Codex CLI login)',
      'Anthropic API key (Claude)',
      'OpenAI API key',
      'OpenRouter (one key, hundreds of models)',
      'Google Gemini API key',
      'Local / self-hosted (Ollama, vLLM, LM Studio — OpenAI-compatible)',
    ]) {
      expect(text).toContain(title);
    }
    // no CLI on this box → login entries are honest, never silently hidden
    expect(text).toContain('the `claude` CLI was not found on PATH');
    expect(text).toContain('the `codex` CLI was not found on PATH');
  });

  it('claude subscription: detected + logged in → bound as main with NO key anywhere', async () => {
    kernel.close();
    openKernel({ claude: 'ready' });
    // recommended becomes 1 (ready login) — Enter accepts it
    const { deps, output } = scripted(['', 'n'], [], telegramOk);
    await runSetupWizard(client, deps);
    expect(output()).toContain('logged in via Claude Code');
    expect(output()).toContain('no key is stored or forwarded');

    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider).toBe('claude-code');
    expect(accounts[0]?.secretRef).toBeNull(); // truly no secret ref
    const roles = await client.call<{ roles: { role: string; resolvesTo: string }[] }>(
      'providers.roles',
    );
    expect(roles.roles.find((r) => r.role === 'main')?.resolvesTo).toBe('claude-code');
  });

  it('claude subscription logged OUT: honest warning, decline returns to the menu', async () => {
    kernel.close();
    openKernel({ claude: 'logged_out' });
    // pick 1 (claude), decline the bind-anyway, then 0 to skip
    const { deps, output } = scripted(['1', 'n', '0', 'n'], [], telegramOk);
    await runSetupWizard(client, deps);
    expect(output()).toContain('not logged in');
    expect(await client.call<AccountLite[]>('accounts.list')).toEqual([]);
  });

  it('codex detected: honestly unavailable (no fake subscription), user picks another path', async () => {
    kernel.close();
    openKernel({ codex: true });
    const { deps, output } = scripted(['2', '5', '', 'n'], ['sk-or-key'], telegramOk);
    await runSetupWizard(client, deps);
    expect(output()).toContain('cannot run chat through it yet');
    // user landed on OpenRouter instead
    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts[0]?.provider).toBe('openrouter');
    expect(accounts[0]?.secretRef).toBe('OPENROUTER_API_KEY');
  });

  it('local endpoint: persists settings config + account + role, key optional', async () => {
    const { deps, output } = scripted(
      ['7', 'http://localhost:11434/v1', 'llama3.1', 'n'],
      [''],
      telegramOk,
    );
    await runSetupWizard(client, deps);
    expect(output()).toContain('local endpoint bound as your main brain');

    const setting = await client.call<{ value: unknown }>('settings.get', {
      key: 'providers.endpoint.local',
    });
    expect(setting.value).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });
    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts[0]?.provider).toBe('local');
    const roles = await client.call<{ roles: { role: string; resolvesTo: string }[] }>(
      'providers.roles',
    );
    expect(roles.roles.find((r) => r.role === 'main')?.resolvesTo).toBe('local');
  });

  it('invalid menu input re-asks instead of crashing (back/retry flow)', async () => {
    const { deps, output } = scripted(['banana', '99', '0', 'n'], [], telegramOk);
    await runSetupWizard(client, deps);
    expect(output()).toContain('not an option');
    expect(await client.call<AccountLite[]>('accounts.list')).toEqual([]);
  });

  it('the brain can be CHANGED after onboarding by re-running the wizard', async () => {
    const first = scripted(['3', '', 'n'], ['sk-ant-key'], telegramOk);
    await runSetupWizard(client, first.deps);

    const second = scripted(['6', '', 'n'], ['gm-key'], telegramOk);
    await runSetupWizard(client, second.deps);

    const roles = await client.call<{ roles: { role: string; resolvesTo: string }[] }>(
      'providers.roles',
    );
    expect(roles.roles.find((r) => r.role === 'main')?.resolvesTo).toBe('gemini');
    const accounts = await client.call<AccountLite[]>('accounts.list');
    expect(accounts.map((a) => a.provider).sort()).toEqual(['anthropic', 'gemini']);
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

describe('sectioned setup (ADR-0026)', () => {
  it('exposes the seven setup sections', () => {
    expect(SETUP_SECTION_IDS).toEqual([
      'brain',
      'roles',
      'runtime',
      'channels',
      'service',
      'agent',
      'tools',
    ]);
  });

  it('an unknown section throws a clear CliError', async () => {
    const { deps } = scripted([], [], telegramOk);
    await expect(runSetupWizard(client, deps, { section: 'nope' })).rejects.toThrow(CliError);
  });

  it('section "agent" enables real lane execution into secrets.env', async () => {
    const { deps, output } = scripted(['y'], [], telegramOk);
    await runSetupWizard(client, deps, { section: 'agent' });
    expect(output()).toContain('enabled');
    expect(parseEnvFile(readFileSync(secretsEnvPath(process.env), 'utf8'))).toMatchObject({
      AMRITA_LANES_ALLOW_REAL_EXECUTION: '1',
    });
  });

  it('section "roles" binds a role through the shared RPC', async () => {
    // bind a brain first so a provider id exists to choose
    process.env.ANTHROPIC_API_KEY = 'placeholder-value-for-tests';
    const brain = scripted(['3', '', 'n'], ['sk-ant'], telegramOk);
    await runSetupWizard(client, brain.deps); // quick: brain + telegram(declined)

    // roles: fast → anthropic, main → keep, deep → keep
    const roles = scripted(['anthropic', '', ''], [], telegramOk);
    await runSetupWizard(client, roles.deps, { section: 'roles' });
    const status = await client.call<{ roles: { role: string; resolvesTo: string }[] }>(
      'runtime.status',
    );
    expect(status.roles.find((r) => r.role === 'fast')?.resolvesTo).toBe('anthropic');
  });

  it('local endpoint section discovers models via /v1 probe and persists config', async () => {
    kernel.close();
    openKernel({ fetchImpl: fakeModels(['llama3.1', 'qwen2.5']) });
    // brain chooser: pick 7 (local) → base URL without /v1 → no key →
    // (probe suggests /v1, finds 2 models) → pick model 2 → decline telegram
    const { deps, output } = scripted(['7', 'http://localhost:11434', '2', 'n'], [''], telegramOk);
    await runSetupWizard(client, deps);
    expect(output()).toContain('endpoint verified');
    const setting = await client.call<{ value: unknown }>('settings.get', {
      key: 'providers.endpoint.local',
    });
    expect(setting.value).toEqual({ baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' });
  });

  it('a full reconfigure backs up existing secrets before running', async () => {
    // first run writes the key to secrets.env (env starts unset)
    const first = scripted(['3', '', 'n'], ['sk-ant'], telegramOk);
    await runSetupWizard(client, first.deps);
    expect(existsSync(secretsEnvPath(process.env))).toBe(true);

    // full run: brain(skip 0), roles(keep x3), channels(decline), agent(decline)
    const full = scripted(['0', '', '', '', 'n', 'n'], [], telegramOk);
    await runSetupWizard(client, full.deps, { full: true });
    const home = join(dir, '.amrita');
    const baks = readdirSync(home).filter((f) => f.startsWith('secrets.env.bak.'));
    expect(baks.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(home, 'config.json'))).toBe(true);
  });
});
