import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel, dispatch, isErrorResponse, runDoctor } from '../src/index.ts';

// A harmless placeholder — NOT a real key and not secret-shaped.
const DUMMY_ENV_VALUE = 'placeholder-value-for-doctor-tests';
const TEST_ENV_NAME = 'AMRITA_DOCTOR_TEST_KEY';
const AUTH_ENV = 'AMRITA_AUTH_TOKEN';
const EXTERNAL_ENVS = ['TELEGRAM_BOT_TOKEN', 'AMRITA_TELEGRAM_ALLOWED_IDS', 'GITHUB_TOKEN'];

let kernel: AmritaKernel;
let savedAuthToken: string | undefined;
const savedExternal: Record<string, string | undefined> = {};

beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
  savedAuthToken = process.env[AUTH_ENV];
  delete process.env[AUTH_ENV]; // deterministic auth posture
  for (const name of EXTERNAL_ENVS) {
    savedExternal[name] = process.env[name];
    delete process.env[name]; // deterministic external-env posture (telegram + github)
  }
});
afterEach(() => {
  kernel.close();
  delete process.env[TEST_ENV_NAME];
  if (savedAuthToken !== undefined) process.env[AUTH_ENV] = savedAuthToken;
  for (const name of EXTERNAL_ENVS) {
    if (savedExternal[name] !== undefined) process.env[name] = savedExternal[name];
  }
});

function section(title: string) {
  const s = runDoctor(kernel).sections.find((x) => x.title === title);
  if (!s) throw new Error(`no section: ${title}`);
  return s;
}

describe('doctor', () => {
  it('a fresh kernel is ok-with-warnings: unconfigured is a warn, never a fail', () => {
    const r = runDoctor(kernel);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('warn');
    expect(r.sections.map((s) => s.title)).toEqual([
      'store',
      'providers',
      'lanes',
      'channels',
      'connectors',
      'auth',
    ]);
    // mock is always ok; real providers warn "needs setup" with an exact fix
    const providers = section('providers');
    expect(providers.checks.find((c) => c.id === 'provider.mock')?.status).toBe('ok');
    const anth = providers.checks.find((c) => c.id === 'provider.anthropic');
    expect(anth?.status).toBe('warn');
    expect(anth?.fix).toContain('account connect --provider anthropic');
    // every warn's fix lands in the numbered footer
    expect(r.fixes.some((f) => f.includes('account connect --provider anthropic'))).toBe(true);
  });

  it('an account bound to a missing env var is a FAIL with a setup fix', () => {
    const projectId = kernel.ensureProject({ slug: 'p', name: 'P' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    const { accountId } = kernel.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    kernel.bindAccountSecretRef(accountId, TEST_ENV_NAME);

    const r = runDoctor(kernel);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('fail');
    const anth = section('providers').checks.find((c) => c.id === 'provider.anthropic');
    expect(anth?.status).toBe('fail');
    expect(anth?.detail).toContain(TEST_ENV_NAME);
    expect(r.fixes.some((f) => f.startsWith('amrita setup') && f.includes(TEST_ENV_NAME))).toBe(
      true,
    );

    // setting the env var (presence only) turns the check ok
    process.env[TEST_ENV_NAME] = DUMMY_ENV_VALUE;
    const healthy = runDoctor(kernel);
    expect(healthy.ok).toBe(true);
    expect(
      healthy.sections
        .find((s) => s.title === 'providers')
        ?.checks.find((c) => c.id === 'provider.anthropic')?.status,
    ).toBe('ok');
    // the secret VALUE never appears anywhere in the report
    expect(JSON.stringify(healthy)).not.toContain(DUMMY_ENV_VALUE);
  });

  it('reports lane posture and honest channel readiness', () => {
    const lanes = section('lanes');
    expect(lanes.checks.find((c) => c.id === 'lanes.realExecution')?.detail).toContain(
      'disabled (safe default)',
    );
    const channels = section('channels');
    expect(channels.checks.find((c) => c.id === 'channel.web')?.status).toBe('ok');
    const tg = channels.checks.find((c) => c.id === 'channel.telegram');
    // honest: the runner exists but needs env (presence-only check)
    expect(tg?.status).toBe('warn');
    expect(tg?.detail).toContain('TELEGRAM_BOT_TOKEN');
    expect(tg?.fix).toContain('--telegram');
  });

  it('auth posture: env token ok, missing token warns with a fix', () => {
    expect(section('auth').checks[0]?.status).toBe('warn');
    process.env[AUTH_ENV] = 'x'; // presence only; removed in afterEach
    expect(section('auth').checks[0]?.status).toBe('ok');
    delete process.env[AUTH_ENV];
  });

  it('is exposed over RPC as `doctor`', async () => {
    const r = await dispatch(kernel, { id: 1, method: 'doctor' });
    expect(isErrorResponse(r)).toBe(false);
    if (!isErrorResponse(r)) {
      const report = r.result as { ok: boolean; sections: unknown[]; fixes: string[] };
      expect(report.ok).toBe(true);
      expect(report.sections).toHaveLength(6);
    }
  });

  it('connectors: github warns with the exact env fix, and is presence-only when set', () => {
    const ghEnv = 'GITHUB_TOKEN';
    const gh = section('connectors').checks.find((c) => c.id === 'connector.github');
    expect(gh?.status).toBe('warn');
    expect(gh?.detail).toContain(ghEnv);
    expect(gh?.fix).toContain('export GITHUB_TOKEN=');

    process.env[ghEnv] = DUMMY_ENV_VALUE; // presence only; removed below
    const after = section('connectors').checks.find((c) => c.id === 'connector.github');
    expect(after?.status).toBe('ok');
    // honest wording: doctor never claims `connected` without a live probe
    expect(after?.detail).toContain('presence-checked only');
    expect(JSON.stringify(runDoctor(kernel))).not.toContain(DUMMY_ENV_VALUE);
    delete process.env[ghEnv];
  });
});
