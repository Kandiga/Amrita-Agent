import { describe, expect, it } from 'vitest';
import {
  type AmritaEvent,
  STREAM_ONLY_TYPES,
  type eventPayloads,
  isStreamOnly,
  laneMandateSchema,
  mergeReportSchema,
  newId,
  parseClientMessage,
  parseEvent,
  parseUnsealedEvent,
} from '../src/index.ts';

function sealed<T extends keyof typeof eventPayloads>(
  type: T,
  payload: unknown,
  over: Partial<Record<string, unknown>> = {},
): unknown {
  return {
    id: newId(),
    seq: 1,
    ts: '2026-06-10T12:00:00.000Z',
    projectId: newId(),
    conversationId: newId(),
    origin: 'user',
    type,
    payload,
    ...over,
  };
}

describe('event protocol', () => {
  it('round-trips a sealed event through parse', () => {
    const input = sealed('message.user', { text: 'hello' });
    const ev = parseEvent(input);
    expect(ev.type).toBe('message.user');
    // serialize -> re-parse must be a fixed point
    const again = parseEvent(JSON.parse(JSON.stringify(ev)));
    expect(again).toEqual(ev);
    if (ev.type === 'message.user') {
      expect(ev.payload.text).toBe('hello'); // discriminated narrowing works
    }
  });

  it('parses an unsealed event without a seq', () => {
    const { seq: _seq, ...rest } = sealed('message.user', { text: 'hi' }) as Record<
      string,
      unknown
    >;
    const ev = parseUnsealedEvent(rest);
    expect(ev.type).toBe('message.user');
    expect('seq' in ev).toBe(false);
  });

  it('rejects a sealed event missing seq', () => {
    const { seq: _seq, ...rest } = sealed('message.user', { text: 'hi' }) as Record<
      string,
      unknown
    >;
    expect(() => parseEvent(rest)).toThrow();
  });

  it('throws on an unknown event type', () => {
    expect(() => parseEvent(sealed('does.not.exist' as never, {}))).toThrow();
  });

  it('throws on a payload that does not match its type', () => {
    expect(() => parseEvent(sealed('message.user', { text: 123 }))).toThrow();
    // unknown key (strict) also throws
    expect(() => parseEvent(sealed('message.agent', { text: 'x', extra: true }))).toThrow();
  });

  it('rejects an unknown envelope field (strict envelope)', () => {
    expect(() => parseEvent(sealed('message.agent', { text: 'x' }, { spoofed: 1 }))).toThrow();
  });

  it('marks model.delta as stream-only', () => {
    expect(isStreamOnly('model.delta')).toBe(true);
    expect(isStreamOnly('message.user')).toBe(false);
    expect(STREAM_ONLY_TYPES.has('model.delta')).toBe(true);
  });

  it('carries optional turnId/laneId/channel when present', () => {
    const ev = parseEvent(
      sealed(
        'tool.started',
        { toolCallId: 'tc1', name: 'fs.read' },
        {
          origin: 'agent',
          turnId: newId(),
          channel: 'web',
        },
      ),
    ) as AmritaEvent;
    expect(ev.channel).toBe('web');
    expect(ev.turnId).toBeTypeOf('string');
  });
});

describe('lane contract', () => {
  const mandate = {
    laneId: newId(),
    goal: 'Fix the PDF export bug',
    contextPack: { memory: ['brief'], files: ['export.ts'], decisions: [] },
    scope: { paths: ['src/'], network: 'none' as const },
    budget: { maxTurns: 12 },
    approvals: 'forward' as const,
    deliverables: ['a passing build'],
  };

  it('validates a LaneMandate and applies defaults', () => {
    const parsed = laneMandateSchema.parse(mandate);
    expect(parsed.goal).toContain('PDF');
    expect(parsed.scope.network).toBe('none');
  });

  it('rejects a LaneMandate with an empty goal', () => {
    expect(() => laneMandateSchema.parse({ ...mandate, goal: '' })).toThrow();
  });

  it('validates a MergeReport with a bounded summary', () => {
    const report = mergeReportSchema.parse({
      laneId: mandate.laneId,
      summary: 'Fixed RTL break in quote template; 2 files changed.',
      decisions: ['use bidi isolate'],
      usage: { inputTokens: 100, outputTokens: 50 },
      exit: 'done',
    });
    expect(report.exit).toBe('done');
    expect(report.artifacts).toEqual([]);
  });

  it('rejects a MergeReport summary over 2000 chars', () => {
    expect(() =>
      mergeReportSchema.parse({
        laneId: mandate.laneId,
        summary: 'x'.repeat(2001),
        usage: { inputTokens: 0, outputTokens: 0 },
        exit: 'done',
      }),
    ).toThrow();
  });
});

describe('rpc', () => {
  it('parses a valid client message', () => {
    const msg = parseClientMessage({ t: 'message.send', conversationId: newId(), text: 'hi' });
    expect(msg.t).toBe('message.send');
  });

  it('rejects an unknown client message kind', () => {
    expect(() => parseClientMessage({ t: 'nope' })).toThrow();
  });
});
