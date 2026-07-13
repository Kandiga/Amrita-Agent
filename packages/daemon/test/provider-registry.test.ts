import { afterEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  type FetchLike,
  type FetchResponseLike,
  PROVIDER_ALIASES,
  REAL_PROVIDERS,
  findProviderSpec,
  normalizeProvider,
  probeOpenAiModels,
  suggestV1BaseUrl,
} from '../src/index.ts';
import { assertSafeProviderUrl, createOpenaiProvider } from '../src/provider.ts';

let kernel: AmritaKernel;
afterEach(() => {
  kernel?.close();
  for (const name of ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL']) delete process.env[name];
});

function ctx(k: AmritaKernel): { projectId: string; conversationId: string } {
  const projectId = k.ensureProject({ slug: 'crm', name: 'CRM' }).id;
  const conversationId = k.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

/** Fake /models fetch returning a fixed catalog. */
function fakeModels(ids: string[], ok = true): FetchLike {
  return async (_url, _init): Promise<FetchResponseLike> => ({
    ok,
    status: ok ? 200 : 500,
    async json() {
      return { data: ids.map((id) => ({ id })) };
    },
    async text() {
      return '';
    },
  });
}

describe('provider aliases & transport (ADR-0026)', () => {
  it('normalizes human/legacy names to canonical ids', () => {
    expect(normalizeProvider('claude')).toBe('anthropic');
    expect(normalizeProvider('ollama')).toBe('local');
    expect(normalizeProvider('open-router')).toBe('openrouter');
    expect(normalizeProvider('GPT')).toBe('openai');
    expect(normalizeProvider('anthropic')).toBe('anthropic'); // identity
    expect(normalizeProvider('totally-unknown')).toBe('totally-unknown'); // pass-through
  });

  it('every alias target is a real catalog id (no dangling aliases)', () => {
    const ids = new Set(REAL_PROVIDERS.map((p) => p.id));
    for (const target of Object.values(PROVIDER_ALIASES)) {
      expect(ids.has(target)).toBe(true);
    }
  });

  it('every executable spec declares a transport and (api_key) discovery metadata', () => {
    for (const spec of REAL_PROVIDERS) {
      expect(spec.transport).toBeTruthy();
      if (spec.authMode === 'api_key') {
        expect(spec.envName).toBeTruthy();
      }
    }
    expect(findProviderSpec('claude')?.id).toBe('anthropic');
  });
});

describe('suggestV1BaseUrl', () => {
  it('adds /v1 to a local URL missing it, leaves others alone', () => {
    expect(suggestV1BaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(suggestV1BaseUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/v1');
    expect(suggestV1BaseUrl('http://localhost:11434/v1')).toBeUndefined();
    expect(suggestV1BaseUrl('https://api.openai.com/v1')).toBeUndefined();
  });
});

describe('probeOpenAiModels', () => {
  it('returns the model ids from a /models response', async () => {
    const probe = await probeOpenAiModels({
      baseUrl: 'http://localhost:11434/v1',
      fetchImpl: fakeModels(['llama3.1', 'qwen2.5']),
    });
    expect(probe.ok).toBe(true);
    expect(probe.models).toEqual(['llama3.1', 'qwen2.5']);
    expect(probe.probedUrl).toBe('http://localhost:11434/v1/models');
  });

  it('is honest (ok:false) when the endpoint errors', async () => {
    const probe = await probeOpenAiModels({
      baseUrl: 'http://localhost:9999/v1',
      fetchImpl: fakeModels([], false),
    });
    expect(probe.ok).toBe(false);
    expect(probe.models).toEqual([]);
  });
});

describe('SSRF guard on provider base URLs (security)', () => {
  it('allows public HTTPS and local (loopback/RFC1918) endpoints — the local-model feature', () => {
    for (const url of [
      'https://api.openai.com/v1',
      'https://openrouter.ai/api/v1',
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://192.168.1.50:8000/v1',
    ]) {
      expect(() => assertSafeProviderUrl(url)).not.toThrow();
    }
  });

  it('blocks cloud-metadata + non-http schemes', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://[fe80::1]/v1',
      'file:///etc/passwd',
      'gopher://169.254.169.254/',
    ]) {
      expect(() => assertSafeProviderUrl(url), url).toThrow();
    }
  });

  it('a provider aimed at a metadata URL fails closed at construction, never fetches', () => {
    let fetched = false;
    const spyFetch: FetchLike = () => {
      fetched = true;
      return Promise.reject(new Error('should never run'));
    };
    // The guard is at the choke point (adapter construction), so a hostile
    // base URL is rejected before any turn — the fetch is never even reachable.
    expect(() =>
      createOpenaiProvider({
        apiKey: 'k',
        model: 'm',
        baseUrl: 'http://169.254.169.254/v1',
        fetchImpl: spyFetch,
      }),
    ).toThrow(/metadata/);
    expect(fetched).toBe(false);
  });

  it('the /models probe returns a safe fallback (never throws) for a blocked URL', async () => {
    const probe = await probeOpenAiModels({
      baseUrl: 'http://169.254.169.254/v1',
      fetchImpl: (() => {
        throw new Error('should never run');
      }) as unknown as FetchLike,
    });
    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain('metadata');
  });
});

describe('kernel.discoverModels', () => {
  it('returns the curated list for a provider without live discovery', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const r = await kernel.discoverModels('anthropic');
    expect(r.source).toBe('curated');
    expect(r.models).toContain('claude-sonnet-4-5');
  });

  it('uses live /models for openrouter when an account+key exist', async () => {
    process.env.OPENROUTER_API_KEY = 'placeholder-value-for-tests';
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      fetchImpl: fakeModels(['anthropic/claude-sonnet-4.5', 'openai/gpt-4o']),
    });
    const c = ctx(kernel);
    const { accountId } = kernel.connectProviderAccount({
      ...c,
      provider: 'openrouter',
      authMode: 'api_key',
    });
    kernel.bindAccountSecretRef(accountId, 'OPENROUTER_API_KEY');
    const r = await kernel.discoverModels('openrouter');
    expect(r.source).toBe('live');
    expect(r.models).toContain('openai/gpt-4o');
  });

  it('falls back to curated when live discovery fails', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeModels([], false) });
    const r = await kernel.discoverModels('openai');
    expect(r.source).toBe('curated');
    expect(r.models.length).toBeGreaterThan(0);
  });
});

describe('kernel.probeEndpoint (custom endpoint setup)', () => {
  it('suggests /v1 and discovers models for a local server', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      fetchImpl: fakeModels(['llama3.1']),
    });
    const r = await kernel.probeEndpoint('http://localhost:11434');
    expect(r.suggestedUrl).toBe('http://localhost:11434/v1');
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(['llama3.1']);
  });
});

describe('baseUrlEnvVar override', () => {
  it('an OPENROUTER_BASE_URL override redirects the chat request', async () => {
    const seen: { url?: string } = {};
    const capture: FetchLike = async (url, _init) => {
      seen.url = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
        async text() {
          return '';
        },
      };
    };
    process.env.OPENROUTER_API_KEY = 'placeholder-value-for-tests';
    process.env.OPENROUTER_BASE_URL = 'https://proxy.example.com/api/v1';
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: capture });
    const c = ctx(kernel);
    const { accountId } = kernel.connectProviderAccount({
      ...c,
      provider: 'openrouter',
      authMode: 'api_key',
    });
    kernel.bindAccountSecretRef(accountId, 'OPENROUTER_API_KEY');
    await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      provider: 'openrouter',
    });
    expect(seen.url).toBe('https://proxy.example.com/api/v1/chat/completions');
  });
});

describe('runtime registry (ADR-0026 / 0043)', () => {
  it('reports all three runtimes; none faked when no CLI is present', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: async () => ({ kind: 'spawn_error' }),
    });
    const runtimes = await kernel.getCodingRuntimes();
    expect(runtimes.map((r) => r.id)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(runtimes.every((r) => r.state === 'not_installed')).toBe(true);
  });

  it('codex now gets a REAL auth probe (login status), like claude-code — not detection-only', async () => {
    // logged in → ready
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: async (cmd, args) =>
        cmd === 'codex' ? { kind: 'ok', stdout: '0.144.1' } : { kind: 'spawn_error' },
    });
    const ready = (await kernel.getCodingRuntimes()).find((r) => r.id === 'codex');
    expect(ready?.state).toBe('ready');
    expect(ready?.detail).toContain('ChatGPT subscription');
    kernel.close();

    // installed but logged OUT → honest, with the exact fix
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: async (cmd, args) => {
        if (cmd !== 'codex') return { kind: 'spawn_error' };
        return args[0] === '--version'
          ? { kind: 'ok', stdout: '0.144.1' }
          : { kind: 'failed', stdout: 'not logged in' };
      },
    });
    const out = (await kernel.getCodingRuntimes()).find((r) => r.id === 'codex');
    expect(out?.state).toBe('installed_unauthenticated');
    expect(out?.nextCommand).toBe('codex login');
  });

  it('surfaces the lane tool allowlist on claude-code only (ADR-0043)', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      allowRealLaneExecution: true,
      laneAllowedTools: ['Write', 'Edit', 'Read'],
      codingRuntimeProber: async () => ({ kind: 'ok', stdout: 'v1' }),
    });
    const runtimes = await kernel.getCodingRuntimes();
    expect(runtimes.find((r) => r.id === 'claude-code')?.allowedTools).toEqual([
      'Write',
      'Edit',
      'Read',
    ]);
    // codex sandboxes by directory, not by tool allowlist — no phantom field
    expect(runtimes.find((r) => r.id === 'codex')?.allowedTools).toBeUndefined();
  });

  it('omits allowedTools entirely when no tools are granted (chat grants zero)', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: async () => ({ kind: 'ok', stdout: 'v1' }),
    });
    const cc = (await kernel.getCodingRuntimes()).find((r) => r.id === 'claude-code');
    expect(cc?.allowedTools).toBeUndefined();
  });
});

describe('alias-aware role binding', () => {
  it('`amrita role set main claude` stores the canonical anthropic id', () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    kernel.setRoleBinding({ role: 'main', provider: 'claude' });
    expect(kernel.getRoleBinding('main')?.provider).toBe('anthropic');
  });
});
