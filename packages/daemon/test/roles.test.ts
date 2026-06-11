import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  type FetchLike,
  type FetchResponseLike,
  dispatch,
  isErrorResponse,
} from '../src/index.ts';

// A harmless placeholder — NOT a real key and not secret-shaped.
const DUMMY_ENV_VALUE = 'placeholder-value-for-role-tests';
const TEST_ENV_NAME = 'AMRITA_ROLE_TEST_KEY';

let kernel: AmritaKernel;
afterEach(() => {
  kernel?.close();
  delete process.env[TEST_ENV_NAME];
});

const fakeAnthropic: FetchLike = async (): Promise<FetchResponseLike> => ({
  ok: true,
  status: 200,
  async json() {
    return {
      content: [{ type: 'text', text: 'role-routed reply' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 2 },
    };
  },
  async text() {
    return '';
  },
});

function ctx(k: AmritaKernel): { projectId: string; conversationId: string } {
  const projectId = k.ensureProject({ slug: 'r', name: 'R' }).id;
  const conversationId = k.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

function bindAnthropic(k: AmritaKernel, c: { projectId: string; conversationId: string }): void {
  const { accountId } = k.connectProviderAccount({
    ...c,
    provider: 'anthropic',
    authMode: 'api_key',
  });
  k.bindAccountSecretRef(accountId, TEST_ENV_NAME);
  process.env[TEST_ENV_NAME] = DUMMY_ENV_VALUE;
}

describe('role policy (D5/ADR-0017)', () => {
  beforeEach(() => {
    kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: fakeAnthropic });
  });

  it('an unbound role resolves via auto to mock when nothing real is configured', async () => {
    const c = ctx(kernel);
    expect(kernel.resolveRole('main')).toEqual({ provider: 'mock', via: 'auto' });

    const turn = await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      role: 'fast',
    });
    expect(turn.provider).toBe('mock');
    expect(turn.role).toBe('fast');
    // the resolved role lands on the persisted model.request event
    const req = kernel
      .listEvents(c.conversationId)
      .find((e) => e.type === 'model.request') as unknown as { payload: { role: string } };
    expect(req.payload.role).toBe('fast');
  });

  it('auto prefers the first AVAILABLE real provider once one is configured', async () => {
    const c = ctx(kernel);
    bindAnthropic(kernel, c);
    expect(kernel.resolveRole('main')).toEqual({ provider: 'anthropic', via: 'auto' });
    const turn = await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      role: 'main',
    });
    expect(turn.provider).toBe('anthropic');
    expect(turn.text).toBe('role-routed reply');
    expect(JSON.stringify(turn)).not.toContain(DUMMY_ENV_VALUE);
  });

  it('a settings binding wins over auto and carries its model', async () => {
    const c = ctx(kernel);
    bindAnthropic(kernel, c);
    kernel.updateSetting({
      ...c,
      key: 'providers.role.deep',
      value: { provider: 'anthropic', model: 'claude-test-model' },
    });
    expect(kernel.resolveRole('deep')).toEqual({
      provider: 'anthropic',
      model: 'claude-test-model',
      via: 'binding',
    });
    const turn = await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      role: 'deep',
    });
    expect(turn.model).toBe('claude-test-model');
    // an explicit model still overrides the binding's model
    const explicit = await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      role: 'deep',
      model: 'claude-other',
    });
    expect(explicit.model).toBe('claude-other');
  });

  it('an explicit provider always beats the role binding', async () => {
    const c = ctx(kernel);
    bindAnthropic(kernel, c);
    kernel.updateSetting({
      ...c,
      key: 'providers.role.main',
      value: { provider: 'anthropic' },
    });
    const turn = await kernel.runChatTurn({
      conversationId: c.conversationId,
      text: 'hi',
      provider: 'mock',
      role: 'main',
    });
    expect(turn.provider).toBe('mock');
    expect(turn.role).toBe('main');
  });

  it('a malformed or cleared binding falls back to auto', () => {
    const c = ctx(kernel);
    kernel.updateSetting({ ...c, key: 'providers.role.fast', value: { nonsense: true } });
    expect(kernel.resolveRole('fast').via).toBe('auto');
    kernel.updateSetting({ ...c, key: 'providers.role.fast', value: { provider: 'mock' } });
    expect(kernel.resolveRole('fast').via).toBe('binding');
    kernel.updateSetting({ ...c, key: 'providers.role.fast', value: null });
    expect(kernel.resolveRole('fast').via).toBe('auto');
  });

  it('providers.roles RPC reports bindings and resolution; bad roles are invalid_params', async () => {
    const c = ctx(kernel);
    const r = await dispatch(kernel, { id: 1, method: 'providers.roles' });
    expect(isErrorResponse(r)).toBe(false);
    if (!isErrorResponse(r)) {
      const roles = (r.result as { roles: { role: string; via: string }[] }).roles;
      expect(roles.map((x) => x.role)).toEqual(['fast', 'main', 'deep']);
      expect(roles.every((x) => x.via === 'auto')).toBe(true);
    }
    const bad = await dispatch(kernel, {
      id: 2,
      method: 'chat.turn',
      params: { conversationId: c.conversationId, text: 'x', role: 'galactic' },
    });
    expect(isErrorResponse(bad) && bad.error.code).toBe('invalid_params');
  });

  it('providers.list reports streaming capability honestly', () => {
    const list = kernel.listProviders();
    expect(list.find((p) => p.id === 'mock')?.streaming).toBe(true); // generateStream implemented
    expect(list.find((p) => p.id === 'anthropic')?.streaming).toBe(false); // SSE not built yet
    expect(list.find((p) => p.id === 'openai')?.streaming).toBe(false);
  });
});
