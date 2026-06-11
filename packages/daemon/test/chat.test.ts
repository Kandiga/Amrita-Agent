import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  type FetchLike,
  type FetchResponseLike,
  MockProvider,
  dispatch,
  isErrorResponse,
} from '../src/index.ts';

// A harmless placeholder env value — NOT a real key and not secret-shaped.
const DUMMY_ENV_VALUE = 'placeholder-value-for-tests';
const TEST_ENV_NAME = 'AMRITA_TEST_PROVIDER_KEY';

let kernel: AmritaKernel;
afterEach(() => {
  kernel?.close();
  delete process.env[TEST_ENV_NAME];
});

function ctx(k: AmritaKernel): { projectId: string; conversationId: string } {
  const projectId = k.ensureProject({ slug: 'crm', name: 'CRM' }).id;
  const conversationId = k.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

/** A fake fetch returning a canned anthropic response, capturing what it received. */
function fakeAnthropic(capture: { auth?: string; status?: number }, status = 200): FetchLike {
  return async (_url, init): Promise<FetchResponseLike> => {
    capture.auth = init.headers['x-api-key'] ?? '';
    capture.status = status;
    return {
      ok: status < 400,
      status,
      async json() {
        return {
          content: [{ type: 'text', text: 'real reply from the adapter' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 5 },
        };
      },
      async text() {
        return '';
      },
    };
  };
}

describe('provider listing (kernel)', () => {
  beforeEach(() => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
  });
  it('shows mock available and real providers unconfigured, with no secret values', () => {
    const list = kernel.listProviders();
    expect(list.find((p) => p.id === 'mock')?.available).toBe(true);
    const anth = list.find((p) => p.id === 'anthropic');
    expect(anth?.kind).toBe('real');
    expect(anth?.available).toBe(false);
    expect(anth?.configuredAccounts).toBe(0);
    expect(JSON.stringify(list)).not.toMatch(/sk-|placeholder-value/i);
  });

  it('mock provider is deterministic', async () => {
    const p = new MockProvider();
    const a = await p.generate({ messages: [{ role: 'user', text: 'hi' }], model: 'm' });
    const b = await p.generate({ messages: [{ role: 'user', text: 'hi' }], model: 'm' });
    expect(a).toEqual(b);
    expect(a.text).toContain('hi');
  });
});

describe('chat turn — mock (kernel)', () => {
  beforeEach(() => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
  });

  it('records user + assistant messages and the full event sequence', async () => {
    const { conversationId } = ctx(kernel);
    const turn = await kernel.runChatTurn({ conversationId, text: 'fix the PDF export bug' });
    expect(turn.provider).toBe('mock');
    expect(turn.text).toContain('PDF export');
    expect(turn.assistantMessageId).toBeTypeOf('string');
    expect(kernel.listEvents(conversationId).map((e) => e.type)).toEqual([
      'message.user',
      'turn.started',
      'model.request',
      'model.response',
      'model.usage',
      'message.agent',
      'turn.completed',
    ]);
    expect(kernel.store.listMessages(conversationId).map((m) => m.role)).toEqual(['user', 'agent']);
    expect(kernel.store.searchMessages('deterministic').some((h) => h.role === 'agent')).toBe(true);
  });

  it('dryRun records only the user message', async () => {
    const { conversationId } = ctx(kernel);
    const turn = await kernel.runChatTurn({ conversationId, text: 'hello', dryRun: true });
    expect(turn.dryRun).toBe(true);
    expect(turn.assistantMessageId).toBeNull();
    expect(kernel.listEvents(conversationId).map((e) => e.type)).toEqual(['message.user']);
  });

  it('rejects unknown providers / unconfigured real providers / missing accounts safely', async () => {
    const { conversationId } = ctx(kernel);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'x', provider: 'nope' }),
    ).rejects.toThrow(/unknown provider/);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'x', provider: 'anthropic' }),
    ).rejects.toThrow(/no configured account/);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'x', accountId: 'NOSUCH' }),
    ).rejects.toThrow(/no such account/);
    // a config failure records nothing
    expect(kernel.listEvents(conversationId)).toHaveLength(0);
  });
});

describe('chat turn — streaming model.delta (kernel)', () => {
  beforeEach(() => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
  });

  it('fans out stream-only deltas that concatenate to the final text, and persists none', async () => {
    const { conversationId } = ctx(kernel);
    const deltas: { type: string; seq: number; turnId?: string; payload: { text?: string } }[] = [];
    const unsubscribe = kernel.subscribeStream((ev) =>
      deltas.push(ev as unknown as (typeof deltas)[number]),
    );

    const turn = await kernel.runChatTurn({ conversationId, text: 'stream me a long reply' });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((d) => d.type === 'model.delta' && d.seq === 0)).toBe(true);
    expect(deltas.every((d) => d.turnId === turn.turnId)).toBe(true);
    expect(deltas.map((d) => d.payload.text ?? '').join('')).toBe(turn.text);
    // D8: model.delta is never persisted — the event log holds the full turn without it.
    expect(kernel.listEvents(conversationId).some((e) => e.type === 'model.delta')).toBe(false);

    // unsubscribe stops fan-out
    unsubscribe();
    const before = deltas.length;
    await kernel.runChatTurn({ conversationId, text: 'again' });
    expect(deltas.length).toBe(before);
  });

  it('a throwing stream subscriber never breaks the turn', async () => {
    const { conversationId } = ctx(kernel);
    kernel.subscribeStream(() => {
      throw new Error('bad subscriber');
    });
    const turn = await kernel.runChatTurn({ conversationId, text: 'still works' });
    expect(turn.text).toContain('still works');
  });
});

describe('chat turn — real adapter (injected fetch, no network)', () => {
  it('calls the anthropic adapter with the env secret and returns assistant text', async () => {
    const capture: { auth?: string } = {};
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeAnthropic(capture) });
    const { projectId, conversationId } = ctx(kernel);
    const sysConv = kernel.createConversation({ projectId }).id;
    const { accountId } = kernel.connectProviderAccount({
      projectId,
      conversationId: sysConv,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    kernel.bindAccountSecretRef(accountId, TEST_ENV_NAME);
    process.env[TEST_ENV_NAME] = DUMMY_ENV_VALUE;

    const turn = await kernel.runChatTurn({ conversationId, text: 'hello', provider: 'anthropic' });
    expect(turn.provider).toBe('anthropic');
    expect(turn.text).toBe('real reply from the adapter');
    expect(turn.usage).toEqual({ inputTokens: 11, outputTokens: 5 });
    // the secret value reached the auth header (in-process only)…
    expect(capture.auth).toBe(DUMMY_ENV_VALUE);
    // …but never the turn result or the persisted events
    expect(JSON.stringify(turn)).not.toContain(DUMMY_ENV_VALUE);
    const events = kernel.listEvents(conversationId);
    expect(JSON.stringify(events)).not.toContain(DUMMY_ENV_VALUE);
    expect(kernel.listProviders().find((p) => p.id === 'anthropic')?.available).toBe(true);
  });

  it('maps a provider HTTP error to a safe ProviderError (no headers/secret)', async () => {
    const capture: { auth?: string } = {};
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeAnthropic(capture, 401) });
    const { projectId, conversationId } = ctx(kernel);
    const { accountId } = kernel.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    kernel.bindAccountSecretRef(accountId, TEST_ENV_NAME);
    process.env[TEST_ENV_NAME] = DUMMY_ENV_VALUE;

    await expect(
      kernel.runChatTurn({ conversationId, text: 'hi', provider: 'anthropic' }),
    ).rejects.toThrow(/status 401/);
    // turn.failed recorded; no secret leaked into events
    const types = kernel.listEvents(conversationId).map((e) => e.type);
    expect(types).toContain('turn.failed');
    expect(JSON.stringify(kernel.listEvents(conversationId))).not.toContain(DUMMY_ENV_VALUE);
  });

  it('errors safely when secret_ref is unbound or the env var is missing', async () => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeAnthropic({}) });
    const { projectId, conversationId } = ctx(kernel);
    const { accountId } = kernel.connectProviderAccount({
      projectId,
      conversationId,
      provider: 'anthropic',
      authMode: 'api_key',
    });
    // account selected by id but no secret_ref bound yet
    await expect(
      kernel.runChatTurn({ conversationId, text: 'x', provider: 'anthropic', accountId }),
    ).rejects.toThrow(/no secret_ref bound/);
    // bound, but env var not set
    kernel.bindAccountSecretRef(accountId, TEST_ENV_NAME);
    await expect(
      kernel.runChatTurn({ conversationId, text: 'x', provider: 'anthropic', accountId }),
    ).rejects.toThrow(new RegExp(`env var ${TEST_ENV_NAME} is not set`));
  });
});

describe('chat turn (rpc, async)', () => {
  beforeEach(() => {
    kernel = AmritaKernel.open({ dbPath: ':memory:' });
  });
  async function call(method: string, params: unknown): Promise<unknown> {
    const r = await dispatch(kernel, { id: 1, method, params });
    if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result;
  }

  it('awaits async handlers and returns a safe structured result', async () => {
    const { conversationId } = ctx(kernel);
    const turn = (await call('chat.turn', { conversationId, text: 'hello there' })) as {
      provider: string;
      text: string;
    };
    expect(turn.provider).toBe('mock');
    expect(turn.text).toContain('hello there');

    const missing = await dispatch(kernel, {
      id: 1,
      method: 'chat.turn',
      params: { conversationId },
    });
    expect(isErrorResponse(missing) && missing.error.code).toBe('invalid_params');

    const unconf = await dispatch(kernel, {
      id: 1,
      method: 'chat.turn',
      params: { conversationId, text: 'x', provider: 'anthropic' },
    });
    expect(isErrorResponse(unconf) && unconf.error.code).toBe('not_found');
    if (isErrorResponse(unconf)) expect(unconf.error.message).not.toMatch(/sk-/i);
  });

  it('providers.list via RPC exposes no secret values', async () => {
    const list = (await call('providers.list', {})) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list)).not.toMatch(/sk-|password/i);
  });
});
