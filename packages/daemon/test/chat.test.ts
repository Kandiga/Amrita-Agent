import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AmritaKernel,
  MockProvider,
  ProviderRegistry,
  dispatch,
  isErrorResponse,
} from '../src/index.ts';

let kernel: AmritaKernel;
beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => {
  kernel.close();
});

function ctx(): { projectId: string; conversationId: string } {
  const projectId = kernel.ensureProject({ slug: 'crm', name: 'CRM' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  return { projectId, conversationId };
}

describe('provider registry', () => {
  it('lists mock available + scaffolds unavailable, with no secret values', () => {
    const list = new ProviderRegistry().list();
    expect(list.find((p) => p.id === 'mock')?.available).toBe(true);
    const anth = list.find((p) => p.id === 'anthropic');
    expect(anth?.available).toBe(false);
    expect(anth?.requiresEnv).toBe('ANTHROPIC_API_KEY');
    expect(typeof anth?.envPresent).toBe('boolean');
    expect(JSON.stringify(list)).not.toMatch(/sk-/i);
  });

  it('mock provider is deterministic', () => {
    const p = new MockProvider();
    const a = p.generate({ messages: [{ role: 'user', text: 'hi' }], model: 'm' });
    const b = p.generate({ messages: [{ role: 'user', text: 'hi' }], model: 'm' });
    expect(a).toEqual(b);
    expect(a.text).toContain('hi');
  });
});

describe('chat turn (kernel)', () => {
  it('records user + assistant messages and the full event sequence', () => {
    const { conversationId } = ctx();
    const turn = kernel.runChatTurn({ conversationId, text: 'fix the PDF export bug' });
    expect(turn.provider).toBe('mock');
    expect(turn.text).toContain('PDF export');
    expect(turn.assistantMessageId).toBeTypeOf('string');
    expect(turn.usage?.inputTokens).toBeGreaterThanOrEqual(0);

    expect(kernel.listEvents(conversationId).map((e) => e.type)).toEqual([
      'message.user',
      'turn.started',
      'model.request',
      'model.response',
      'model.usage',
      'message.agent',
      'turn.completed',
    ]);
    const msgs = kernel.store.listMessages(conversationId);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent']);
    expect(kernel.store.searchMessages('deterministic').some((h) => h.role === 'agent')).toBe(true);
  });

  it('dryRun records only the user message', () => {
    const { conversationId } = ctx();
    const turn = kernel.runChatTurn({ conversationId, text: 'hello', dryRun: true });
    expect(turn.dryRun).toBe(true);
    expect(turn.assistantMessageId).toBeNull();
    expect(kernel.listEvents(conversationId).map((e) => e.type)).toEqual(['message.user']);
  });

  it('rejects unknown/scaffold providers and missing accounts safely', () => {
    const { conversationId } = ctx();
    expect(() => kernel.runChatTurn({ conversationId, text: 'x', provider: 'anthropic' })).toThrow(
      /scaffolded but not implemented/,
    );
    expect(() => kernel.runChatTurn({ conversationId, text: 'x', provider: 'nope' })).toThrow(
      /unknown provider/,
    );
    expect(() => kernel.runChatTurn({ conversationId, text: 'x', accountId: 'NOSUCH' })).toThrow(
      /no such account/,
    );
  });
});

describe('chat turn (rpc)', () => {
  function call(method: string, params: unknown): unknown {
    const r = dispatch(kernel, { id: 1, method, params });
    if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result;
  }

  it('returns a safe structured result and validates params', () => {
    const { conversationId } = ctx();
    const turn = call('chat.turn', { conversationId, text: 'hello there' }) as {
      provider: string;
      text: string;
      usage: { inputTokens: number };
    };
    expect(turn.provider).toBe('mock');
    expect(turn.text).toContain('hello there');
    expect(turn.usage.inputTokens).toBeGreaterThanOrEqual(0);

    const missing = dispatch(kernel, { id: 1, method: 'chat.turn', params: { conversationId } });
    expect(isErrorResponse(missing) && missing.error.code).toBe('invalid_params');

    const unav = dispatch(kernel, {
      id: 1,
      method: 'chat.turn',
      params: { conversationId, text: 'x', provider: 'anthropic' },
    });
    expect(isErrorResponse(unav) && unav.error.code).toBe('provider_unavailable');
    if (isErrorResponse(unav)) expect(unav.error.message).not.toMatch(/sk-/i);
  });

  it('providers.list via RPC exposes no secret values', () => {
    const list = call('providers.list', {}) as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(list)).not.toMatch(/sk-|password/i);
  });
});
