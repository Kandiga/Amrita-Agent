import { describe, expect, it } from 'vitest';
import { RpcError } from '../src/api.ts';
import { messagesFromEvents, safeErrorMessage, textDir } from '../src/lib.ts';

describe('web pure helpers', () => {
  it('detects rtl text for Hebrew and ltr text for English', () => {
    expect(textDir('שלום אמריטה')).toBe('rtl');
    expect(textDir('hello amrita')).toBe('ltr');
  });

  it('builds chat messages from replayed message events only', () => {
    expect(
      messagesFromEvents([
        { id: '1', seq: 1, ts: 't', type: 'turn.started', payload: {} },
        { id: '2', seq: 2, ts: 't', type: 'message.user', payload: { text: 'hi' } },
        { id: '3', seq: 3, ts: 't', type: 'message.agent', payload: { text: 'hello' } },
      ]),
    ).toEqual([
      { id: '2', role: 'user', text: 'hi' },
      { id: '3', role: 'agent', text: 'hello' },
    ]);
  });

  it('formats safe error messages without stack traces', () => {
    const msg = safeErrorMessage(
      new RpcError('missing_env_value', 'Missing configured environment value'),
    );
    expect(msg).toBe('missing_env_value: Missing configured environment value');
    expect(msg).not.toMatch(/at .*\(|sk-|password/i);
  });
});
