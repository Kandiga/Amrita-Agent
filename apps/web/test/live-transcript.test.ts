import { describe, expect, it } from 'vitest';
import type { AmritaEventLite } from '../src/api.ts';
import {
  emptyTranscript,
  foldEvents,
  reduceEvent,
  transcriptMessages,
} from '../src/live-transcript.ts';

function ev(partial: Partial<AmritaEventLite> & { id: string; type: string }): AmritaEventLite {
  return { seq: 0, ts: 't', payload: {}, ...partial };
}

describe('live transcript reducer', () => {
  it('folds user and agent messages into ordered transcript messages', () => {
    let s = emptyTranscript();
    s = reduceEvent(s, ev({ id: '1', seq: 1, type: 'message.user', payload: { text: 'hi' } }));
    s = reduceEvent(s, ev({ id: '2', seq: 2, type: 'message.agent', payload: { text: 'hello' } }));
    expect(transcriptMessages(s)).toEqual([
      { id: '1', role: 'user', text: 'hi' },
      { id: '2', role: 'agent', text: 'hello' },
    ]);
    expect(s.lastSeq).toBe(2);
  });

  it('ignores non-transcript events but still advances lastSeq', () => {
    let s = emptyTranscript();
    s = reduceEvent(
      s,
      ev({ id: 't1', seq: 5, type: 'turn.started', payload: { trigger: 'user' } }),
    );
    s = reduceEvent(s, ev({ id: 'm1', seq: 6, type: 'model.request', payload: {} }));
    expect(transcriptMessages(s)).toEqual([]);
    expect(s.lastSeq).toBe(6);
  });

  it('de-dupes by event id so a replay on reconnect changes nothing', () => {
    const events = [
      ev({ id: '1', seq: 1, type: 'message.user', payload: { text: 'hi' } }),
      ev({ id: '2', seq: 2, type: 'message.agent', payload: { text: 'hello' } }),
    ];
    const once = foldEvents(emptyTranscript(), events);
    const twice = foldEvents(once, events); // simulate a reconnect replay
    expect(twice.messages).toHaveLength(2);
    expect(transcriptMessages(twice)).toEqual(transcriptMessages(once));
    // a no-op event returns the same reference (lets React skip re-render)
    expect(reduceEvent(once, events[0] as AmritaEventLite)).toBe(once);
  });

  it('renders model.delta as an in-progress draft bubble, then the final message replaces it', () => {
    let s = emptyTranscript();
    s = reduceEvent(s, ev({ id: 'u', seq: 1, type: 'message.user', payload: { text: 'q' } }));
    s = reduceEvent(s, ev({ id: 'd1', seq: 2, type: 'model.delta', payload: { text: 'Hel' } }));
    s = reduceEvent(s, ev({ id: 'd2', seq: 3, type: 'model.delta', payload: { text: 'lo' } }));
    const mid = transcriptMessages(s);
    expect(mid.at(-1)).toEqual({ id: '__draft__', role: 'agent', text: 'Hello', pending: true });

    s = reduceEvent(s, ev({ id: 'a', seq: 4, type: 'message.agent', payload: { text: 'Hello!' } }));
    const done = transcriptMessages(s);
    expect(done.some((m) => m.pending)).toBe(false);
    expect(done.at(-1)).toEqual({ id: 'a', role: 'agent', text: 'Hello!' });
  });

  it('treats a malformed payload as empty text without throwing', () => {
    const s = reduceEvent(emptyTranscript(), ev({ id: 'x', seq: 1, type: 'message.user' }));
    expect(transcriptMessages(s)).toEqual([{ id: 'x', role: 'user', text: '' }]);
  });
});
