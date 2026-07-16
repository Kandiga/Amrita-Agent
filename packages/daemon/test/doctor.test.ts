import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  type CommandProber,
  dispatch,
  isErrorResponse,
  runDoctor,
} from '../src/index.ts';

// A harmless placeholder — NOT a real key and not secret-shaped.
const DUMMY_ENV_VALUE = 'placeholder-value-for-doctor-tests';
const TEST_ENV_NAME = 'AMRITA_DOCTOR_TEST_KEY';
const AUTH_ENV = 'AMRITA_AUTH_TOKEN';
const EXTERNAL_ENVS = [
  'TELEGRAM_BOT_TOKEN',
  'AMRITA_TELEGRAM_ALLOWED_IDS',
  'GITHUB_TOKEN',
  'BRAIN_BRIDGE_TOKEN',
  'AMRITA_CINEMA_BRIDGE_URL',
];

// Deterministic runtime posture: no CLIs found, so doctor never depends on what
// happens to be installed on the test host.
const noRuntimes: CommandProber = async () => ({ kind: 'spawn_error' });

let kernel: AmritaKernel;
let dir: string;
let savedAuthToken: string | undefined;
let savedHome: string | undefined;
const savedExternal: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'amrita-doctor-'));
  savedHome = process.env.AMRITA_HOME;
  process.env.AMRITA_HOME = join(dir, '.amrita');
  kernel = AmritaKernel.open({ dbPath: ':memory:', codingRuntimeProber: noRuntimes });
  savedAuthToken = process.env[AUTH_ENV];
  delete process.env[AUTH_ENV]; // deterministic auth posture
  for (const name of EXTERNAL_ENVS) {
    savedExternal[name] = process.env[name];
    delete process.env[name]; // deterministic external-env posture (telegram + github)
  }
});
afterEach(() => {
  kernel.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env[TEST_ENV_NAME];
  const homeEnv = 'AMRITA_HOME';
  if (savedHome !== undefined) process.env[homeEnv] = savedHome;
  else delete process.env[homeEnv];
  if (savedAuthToken !== undefined) process.env[AUTH_ENV] = savedAuthToken;
  for (const name of EXTERNAL_ENVS) {
    if (savedExternal[name] !== undefined) process.env[name] = savedExternal[name];
  }
});

async function section(title: string) {
  const s = (await runDoctor(kernel)).sections.find((x) => x.title === title);
  if (!s) throw new Error(`no section: ${title}`);
  return s;
}

// Cinema is a PRIVATE module — hidden unless BRAIN_BRIDGE_TOKEN/URL is set.
const SECTION_ORDER = [
  'home',
  'store',
  'providers',
  'runtimes',
  'lanes',
  'channels',
  'connectors',
  'skills',
  'auth',
];

describe('doctor', () => {
  it('a fresh kernel is ok-with-warnings: unconfigured is a warn, never a fail', async () => {
    const r = await runDoctor(kernel);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('warn');
    expect(r.sections.map((s) => s.title)).toEqual(SECTION_ORDER);
    // mock is always ok; an unconfigured brain is ONE quiet summary warn
    // (ADR-0025) instead of a warn-per-provider wall
    const providers = await section('providers');
    expect(providers.checks.find((c) => c.id === 'provider.mock')?.status).toBe('ok');
    expect(providers.checks.find((c) => c.id === 'provider.anthropic')).toBeUndefined();
    const none = providers.checks.find((c) => c.id === 'provider.none');
    expect(none?.status).toBe('warn');
    expect(none?.fix).toBe('amrita setup');
    expect(r.fixes).toContain('amrita setup');
  });

  it('home section reports paths and is clean on a fresh temp home', async () => {
    const home = await section('home');
    expect(home.checks.find((c) => c.id === 'home.dir')?.status).toBe('ok');
    expect(home.checks.find((c) => c.id === 'home.secrets')?.detail).toContain('none yet');
    // no permission failures on a fresh mkdtemp (0700) home
    expect(home.checks.every((c) => c.status !== 'fail')).toBe(true);
  });

  it('runtimes section lists every coding runtime with honest, no-CLI states', async () => {
    const rt = await section('runtimes');
    const ids = rt.checks.map((c) => c.id);
    expect(ids).toEqual(['runtime.claude-code', 'runtime.codex', 'runtime.opencode']);
    // Community onboarding: a coding runtime is OPTIONAL (brain ≠ coding agent),
    // so NOT-INSTALLED is informational `ok` for every runtime — a fresh user who
    // picked an API-key/mock brain isn't "broken" for lacking Claude/Codex CLIs.
    const cc = rt.checks.find((c) => c.id === 'runtime.claude-code');
    expect(cc?.status).toBe('ok');
    expect(rt.checks.find((c) => c.id === 'runtime.codex')?.status).toBe('ok');
    expect(rt.checks.find((c) => c.id === 'runtime.opencode')?.status).toBe('ok');
  });

  it('an account bound to a missing env var is a FAIL with a setup fix', async () => {
    const projectId = kernel.ensureProject({ slug: 'p', name: 'P' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;
    const { accountId } = kernel.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    kernel.bindAccountSecretRef(accountId, TEST_ENV_NAME);

    const r = await runDoctor(kernel);
    expect(r.ok).toBe(false);
    expect(r.status).toBe('fail');
    const anth = (await section('providers')).checks.find((c) => c.id === 'provider.anthropic');
    expect(anth?.status).toBe('fail');
    expect(anth?.detail).toContain(TEST_ENV_NAME);
    expect(r.fixes.some((f) => f.startsWith('amrita setup') && f.includes(TEST_ENV_NAME))).toBe(
      true,
    );

    process.env[TEST_ENV_NAME] = DUMMY_ENV_VALUE;
    const healthy = await runDoctor(kernel);
    expect(healthy.ok).toBe(true);
    expect(
      healthy.sections
        .find((s) => s.title === 'providers')
        ?.checks.find((c) => c.id === 'provider.anthropic')?.status,
    ).toBe('ok');
    expect(JSON.stringify(healthy)).not.toContain(DUMMY_ENV_VALUE);
  });

  it('reports lane posture and honest channel readiness', async () => {
    const lanes = await section('lanes');
    expect(lanes.checks.find((c) => c.id === 'lanes.realExecution')?.detail).toContain(
      'disabled (safe default)',
    );
    const channels = await section('channels');
    expect(channels.checks.find((c) => c.id === 'channel.web')?.status).toBe('ok');
    const tg = channels.checks.find((c) => c.id === 'channel.telegram');
    expect(tg?.status).toBe('warn');
    expect(tg?.detail).toContain('TELEGRAM_BOT_TOKEN');
    expect(tg?.fix).toContain('--telegram');
  });

  it('auth posture: env token ok, missing token warns with a fix', async () => {
    expect((await section('auth')).checks[0]?.status).toBe('warn');
    process.env[AUTH_ENV] = 'x'; // presence only; removed in afterEach
    expect((await section('auth')).checks[0]?.status).toBe('ok');
    delete process.env[AUTH_ENV];
  });

  it('is exposed over RPC as `doctor`', async () => {
    const r = await dispatch(kernel, { id: 1, method: 'doctor' });
    expect(isErrorResponse(r)).toBe(false);
    if (!isErrorResponse(r)) {
      const report = r.result as { ok: boolean; sections: unknown[]; fixes: string[] };
      expect(report.ok).toBe(true);
      expect(report.sections).toHaveLength(SECTION_ORDER.length);
    }
  });

  it('connectors: github warns with the exact env fix, and is presence-only when set', async () => {
    const ghEnv = 'GITHUB_TOKEN';
    const gh = (await section('connectors')).checks.find((c) => c.id === 'connector.github');
    expect(gh?.status).toBe('warn');
    expect(gh?.detail).toContain(ghEnv);
    expect(gh?.fix).toContain('export GITHUB_TOKEN=');

    process.env[ghEnv] = DUMMY_ENV_VALUE; // presence only; removed below
    const after = (await section('connectors')).checks.find((c) => c.id === 'connector.github');
    expect(after?.status).toBe('ok');
    expect(after?.detail).toContain('presence-checked only');
    expect(JSON.stringify(await runDoctor(kernel))).not.toContain(DUMMY_ENV_VALUE);
    delete process.env[ghEnv];
  });
});

describe('doctor profiles (community onboarding)', () => {
  it('every section is tagged core/optional/private; the rollup uses core only', async () => {
    const r = await runDoctor(kernel);
    const byTitle = Object.fromEntries(r.sections.map((s) => [s.title, s.profile]));
    expect(byTitle.home).toBe('core');
    expect(byTitle.providers).toBe('core');
    expect(byTitle.runtimes).toBe('core');
    expect(byTitle.auth).toBe('core');
    expect(byTitle.channels).toBe('optional');
    expect(byTitle.connectors).toBe('optional');
    expect(byTitle.skills).toBe('optional');
    // A fresh kernel: core has legit setup warns (brain/roles/token) → warn, never fail.
    expect(r.status).toBe('warn');
    expect(r.ok).toBe(true);
  });

  it('the private Cinema module is HIDDEN unless explicitly enabled', async () => {
    const off = await runDoctor(kernel);
    expect(off.sections.find((s) => s.title === 'cinema')).toBeUndefined();

    process.env.BRAIN_BRIDGE_TOKEN = 'placeholder-not-a-real-token';
    try {
      const on = await runDoctor(kernel);
      const cinema = on.sections.find((s) => s.title === 'cinema');
      expect(cinema?.profile).toBe('private'); // appears, tagged private
    } finally {
      const BBT = 'BRAIN_BRIDGE_TOKEN';
      delete process.env[BBT];
    }
  });

  it('an installed-but-unauthenticated executable runtime is a warn (codex parity)', async () => {
    // claude ready, codex installed-but-logged-out → codex must NOT be masked ok.
    const prober: CommandProber = async (cmd, args) => {
      const isAuth = args.includes('status') || args.includes('login');
      if (cmd === 'codex')
        return isAuth ? { kind: 'failed', stdout: '' } : { kind: 'ok', stdout: 'codex 1.0' };
      if (cmd === 'claude') return { kind: 'ok', stdout: '2.1.0' };
      return { kind: 'spawn_error' };
    };
    const k2 = AmritaKernel.open({ dbPath: ':memory:', codingRuntimeProber: prober });
    try {
      const rt = (await runDoctor(k2)).sections.find((s) => s.title === 'runtimes');
      const codex = rt?.checks.find((c) => c.id === 'runtime.codex');
      expect(codex?.status).toBe('warn'); // executable + unauthenticated = actionable
    } finally {
      k2.close();
    }
  });
});
