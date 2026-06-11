import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  type CommandProber,
  type ProbeResult,
  dispatch,
  getClaudeCodeStatus,
  isErrorResponse,
} from '../src/index.ts';

/** A fake prober: maps "cmd argv.join" → result. Tests never spawn real CLIs. */
function fakeProber(map: Record<string, ProbeResult>): CommandProber {
  return async (cmd, args) => map[`${cmd} ${args.join(' ')}`] ?? { kind: 'spawn_error' };
}

describe('coding runtime probes (ADR-0019 §6)', () => {
  it('classifies ready / unauthenticated / unknown / not-installed honestly', async () => {
    const ready = await getClaudeCodeStatus({
      realExecution: false,
      prober: fakeProber({
        'claude --version': { kind: 'ok', stdout: '1.2.3 (Claude Code)' },
        'claude auth status': { kind: 'ok', stdout: 'logged in' },
      }),
    });
    expect(ready).toMatchObject({ state: 'ready', version: '1.2.3 (Claude Code)' });

    const unauth = await getClaudeCodeStatus({
      realExecution: false,
      prober: fakeProber({
        'claude --version': { kind: 'ok', stdout: '1.2.3' },
        'claude auth status': { kind: 'failed', stdout: 'not logged in' },
      }),
    });
    expect(unauth.state).toBe('installed_unauthenticated');
    expect(unauth.nextCommand).toBe('claude login');

    const authUnknown = await getClaudeCodeStatus({
      realExecution: true,
      prober: fakeProber({
        'claude --version': { kind: 'ok', stdout: '1.2.3' },
        'claude auth status': { kind: 'timeout' },
      }),
    });
    expect(authUnknown.state).toBe('installed_auth_unknown');
    expect(authUnknown.realExecution).toBe(true);

    const missing = await getClaudeCodeStatus({
      realExecution: false,
      prober: fakeProber({}),
    });
    expect(missing.state).toBe('not_installed');
    expect(missing.nextCommand).toContain('npm install -g');

    const hung = await getClaudeCodeStatus({
      realExecution: false,
      prober: fakeProber({ 'claude --version': { kind: 'timeout' } }),
    });
    expect(hung.state).toBe('status_unknown'); // inconclusive ≠ green
  });

  it('never echoes probe output beyond the version string (no account details leak)', async () => {
    const status = await getClaudeCodeStatus({
      realExecution: false,
      prober: fakeProber({
        'claude --version': { kind: 'ok', stdout: '2.0.0' },
        'claude auth status': { kind: 'ok', stdout: 'logged in as someone@example.com' },
      }),
    });
    expect(JSON.stringify(status)).not.toContain('someone@example.com');
  });
});

describe('runtime.status + providers.role.set/clear over RPC', () => {
  let kernel: AmritaKernel;
  beforeEach(() => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: fakeProber({
        'claude --version': { kind: 'ok', stdout: '1.0.0' },
        'claude auth status': { kind: 'failed', stdout: '' },
      }),
    });
  });
  afterEach(() => kernel.close());

  async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const r = await dispatch(kernel, { id: 1, method, params });
    if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as T;
  }

  it('runtime.status aggregates roles, providers, and probed coding runtimes', async () => {
    const s = await call<{
      roles: { role: string; via: string }[];
      providers: { id: string }[];
      codingRuntimes: { id: string; state: string }[];
    }>('runtime.status');
    expect(s.roles.map((r) => r.role)).toEqual(['fast', 'main', 'deep']);
    expect(s.providers.map((p) => p.id)).toContain('mock');
    // the coding runtime is probed and visible regardless of brain bindings
    expect(s.codingRuntimes[0]).toMatchObject({
      id: 'claude-code',
      state: 'installed_unauthenticated',
    });
    expect(JSON.stringify(s)).not.toMatch(/sk-|password/i);
  });

  it('role.set/clear write through one validated path, global and per-project', async () => {
    const projectId = kernel.ensureProject({ slug: 'hub', name: 'Hub' }).id;
    await call('providers.role.set', { role: 'main', provider: 'mock', model: 'hub-model' });
    await call('providers.role.set', { role: 'main', provider: 'mock', projectId });
    expect(kernel.resolveRole('main')).toMatchObject({ provider: 'mock', via: 'binding' });
    expect(kernel.resolveRole('main', projectId).via).toBe('project');

    await call('providers.role.clear', { role: 'main', projectId });
    expect(kernel.resolveRole('main', projectId).via).toBe('binding');
    await call('providers.role.clear', { role: 'main' });
    expect(kernel.resolveRole('main').via).toBe('auto');

    // guard rails: unknown provider / unknown project are safe structured errors
    const badProvider = await dispatch(kernel, {
      id: 2,
      method: 'providers.role.set',
      params: { role: 'main', provider: 'nope' },
    });
    expect(isErrorResponse(badProvider) && badProvider.error.code).toBe('invalid_params');
    const badProject = await dispatch(kernel, {
      id: 3,
      method: 'providers.role.set',
      params: { role: 'main', provider: 'mock', projectId: 'NOSUCH' },
    });
    expect(isErrorResponse(badProject) && badProject.error.code).toBe('not_found');
  });
});
