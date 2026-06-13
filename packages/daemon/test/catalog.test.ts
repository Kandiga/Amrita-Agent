import { afterEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  type CliExec,
  type CommandProber,
  type FetchLike,
  type FetchResponseLike,
  LOCAL_ENDPOINT_SETTING,
  REAL_PROVIDERS,
} from '../src/index.ts';

// Harmless placeholder values — NOT real keys and not secret-shaped.
const DUMMY = 'placeholder-value-for-tests';
const ENV_NAMES = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'LOCAL_LLM_API_KEY'];

let kernel: AmritaKernel;
afterEach(() => {
  kernel?.close();
  for (const n of ENV_NAMES) delete process.env[n];
});

function ctx(k: AmritaKernel): { projectId: string; conversationId: string } {
  const projectId = k.ensureProject({ slug: 'crm', name: 'CRM' }).id;
  const conversationId = k.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

/** Fake prober controlling which CLIs "exist" and whether claude is logged in. */
function prober(opts: {
  claude?: 'ready' | 'logged_out' | 'missing';
  codex?: boolean;
}): CommandProber {
  return async (cmd, args) => {
    if (cmd === 'claude') {
      if (!opts.claude || opts.claude === 'missing') return { kind: 'spawn_error' };
      if (args[0] === '--version') return { kind: 'ok', stdout: '2.1.0 (Claude Code)' };
      return opts.claude === 'ready'
        ? { kind: 'ok', stdout: 'ok' }
        : { kind: 'failed', stdout: '' };
    }
    if (cmd === 'codex' && opts.codex) return { kind: 'ok', stdout: '1.0.0' };
    return { kind: 'spawn_error' };
  };
}

/** Fake OpenAI-compatible fetch capturing the URL it was called with. */
function fakeCompat(capture: { url?: string; auth?: string }): FetchLike {
  return async (url, init): Promise<FetchResponseLike> => {
    capture.url = url;
    capture.auth = init.headers.authorization ?? '';
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content: 'compat reply' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        };
      },
      async text() {
        return '';
      },
    };
  };
}

function connectAndBind(k: AmritaKernel, provider: string, envName: string): void {
  const c = ctx(k);
  const { accountId } = k.connectProviderAccount({ ...c, provider, authMode: 'api_key' });
  k.bindAccountSecretRef(accountId, envName);
}

describe('provider catalog (ADR-0025)', () => {
  it('covers all seven providers across three groups with required metadata', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', codingRuntimeProber: prober({}) });
    const catalog = await kernel.providersCatalog();
    expect(catalog.map((e) => e.id)).toEqual([
      'claude-code',
      'codex',
      'anthropic',
      'openai',
      'openrouter',
      'gemini',
      'local',
    ]);
    expect(new Set(catalog.map((e) => e.group))).toEqual(new Set(['login', 'api_key', 'local']));
    for (const e of catalog.filter((c) => c.authMode === 'api_key')) {
      expect(e.envName).toBeTruthy();
      expect(e.keyUrl).toBeTruthy();
    }
  });

  it('claude-code states are probe-driven: missing → logged out → ready', async () => {
    for (const [claude, state] of [
      ['missing', 'missing_cli'],
      ['logged_out', 'needs_login'],
      ['ready', 'ready'],
    ] as const) {
      const k = AmritaKernel.open({ dbPath: ':memory:', codingRuntimeProber: prober({ claude }) });
      const entry = (await k.providersCatalog()).find((e) => e.id === 'claude-code');
      expect(entry?.state).toBe(state);
      k.close();
    }
  });

  it('codex is detection-only: present → honestly unavailable, never ready', async () => {
    kernel = AmritaKernel.open({
      dbPath: ':memory:',
      codingRuntimeProber: prober({ codex: true }),
    });
    const entry = (await kernel.providersCatalog()).find((e) => e.id === 'codex');
    expect(entry?.executable).toBe(false);
    expect(entry?.state).toBe('unavailable');
    expect(entry?.detail).toContain('cannot run chat through it yet');
  });

  it('local goes needs_endpoint → ready once the settings config exists', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', codingRuntimeProber: prober({}) });
    expect((await kernel.providersCatalog()).find((e) => e.id === 'local')?.state).toBe(
      'needs_endpoint',
    );
    const c = ctx(kernel);
    kernel.updateSetting({
      ...c,
      key: LOCAL_ENDPOINT_SETTING,
      value: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    });
    const entry = (await kernel.providersCatalog()).find((e) => e.id === 'local');
    expect(entry?.state).toBe('ready');
    expect(entry?.detail).toContain('http://localhost:11434/v1');
  });
});

describe('chat through the new providers', () => {
  it('openrouter hits the gateway URL with the bound key', async () => {
    const capture: { url?: string; auth?: string } = {};
    process.env.OPENROUTER_API_KEY = DUMMY;
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeCompat(capture) });
    connectAndBind(kernel, 'openrouter', 'OPENROUTER_API_KEY');
    const { conversationId } = ctx(kernel);
    const turn = await kernel.runChatTurn({ conversationId, text: 'hi', provider: 'openrouter' });
    expect(turn.text).toBe('compat reply');
    expect(turn.model).toBe('openrouter/auto');
    expect(capture.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(capture.auth).toBe(`Bearer ${DUMMY}`);
  });

  it("gemini hits Google's OpenAI-compatible surface (no double version segment)", async () => {
    const capture: { url?: string } = {};
    process.env.GEMINI_API_KEY = DUMMY;
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeCompat(capture) });
    connectAndBind(kernel, 'gemini', 'GEMINI_API_KEY');
    const { conversationId } = ctx(kernel);
    const turn = await kernel.runChatTurn({ conversationId, text: 'hi', provider: 'gemini' });
    expect(turn.text).toBe('compat reply');
    expect(capture.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('local endpoint: model + URL come from the settings config; no key needed', async () => {
    const capture: { url?: string } = {};
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeCompat(capture) });
    const c = ctx(kernel);
    kernel.updateSetting({
      ...c,
      key: LOCAL_ENDPOINT_SETTING,
      value: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
    });
    const turn = await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      provider: 'local',
    });
    expect(turn.text).toBe('compat reply');
    expect(turn.model).toBe('llama3.1');
    expect(capture.url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('local endpoint unconfigured: structured provider_unavailable, never a crash', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = ctx(kernel);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'hi', provider: 'local' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  it('claude-code chats through the injected CLI exec — subscription, zero secrets', async () => {
    const seen: { args?: string[]; input?: string } = {};
    const cliExec: CliExec = (_cmd, args, input) => {
      seen.args = args;
      seen.input = input;
      return {
        status: 0,
        stdout: JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'subscription reply',
          stop_reason: 'end_turn',
          usage: { input_tokens: 7, output_tokens: 3 },
        }),
        stderr: '',
      };
    };
    kernel = AmritaKernel.open({ dbPath: ':memory:', cliExec });
    const { conversationId } = ctx(kernel);
    const turn = await kernel.runChatTurn({
      conversationId,
      text: 'hello from amrita',
      provider: 'claude-code',
    });
    expect(turn.text).toBe('subscription reply');
    expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(seen.args).toEqual(['-p', '--output-format', 'json', '--model', 'sonnet']);
    expect(seen.input).toContain('hello from amrita');
  });

  it('claude-code logged out: classified, actionable, value-free error', async () => {
    const cliExec: CliExec = () => ({
      status: 1,
      stdout: '',
      stderr: 'Error: please run /login — not authenticated',
    });
    kernel = AmritaKernel.open({ dbPath: ':memory:', cliExec });
    const { conversationId } = ctx(kernel);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'hi', provider: 'claude-code' }),
    ).rejects.toMatchObject({ code: 'provider_error' });
    await expect(
      kernel.runChatTurn({ conversationId, text: 'hi', provider: 'claude-code' }),
    ).rejects.toThrow(/not logged in/);
  });

  it('codex turn refuses honestly: detection-only, with a real alternative named', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
    const { conversationId } = ctx(kernel);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'hi', provider: 'codex' }),
    ).rejects.toThrow(/detection-only.*OpenRouter/);
  });

  it('REAL_PROVIDERS metadata is complete for chooser rendering', () => {
    for (const spec of REAL_PROVIDERS) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(['login', 'api_key', 'local']).toContain(spec.group);
      if (spec.authMode === 'api_key') {
        expect(spec.envName).toBeTruthy();
        expect(spec.keyUrl).toBeTruthy();
      }
      if (spec.executable) expect(spec.create).toBeTypeOf('function');
    }
  });
});
