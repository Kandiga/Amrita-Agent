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

describe('runtime registry (ADR-0026)', () => {
  it('reports all three runtimes; claude-code wired, others detection-only', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: async () => ({ kind: 'spawn_error' }),
    });
    const runtimes = await kernel.getCodingRuntimes();
    expect(runtimes.map((r) => r.id)).toEqual(['claude-code', 'codex', 'opencode']);
    expect(runtimes.every((r) => r.state === 'not_installed')).toBe(true);
  });

  it('detects an installed-but-detection-only runtime honestly', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: async (cmd) =>
        cmd === 'codex' ? { kind: 'ok', stdout: '1.0.0' } : { kind: 'spawn_error' },
    });
    const codex = (await kernel.getCodingRuntimes()).find((r) => r.id === 'codex');
    expect(codex?.state).toBe('installed_auth_unknown');
    expect(codex?.detail).toContain('detection-only');
  });
});

describe('alias-aware role binding', () => {
  it('`amrita role set main claude` stores the canonical anthropic id', () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    kernel.setRoleBinding({ role: 'main', provider: 'claude' });
    expect(kernel.getRoleBinding('main')?.provider).toBe('anthropic');
  });
});
