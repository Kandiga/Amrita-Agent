import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AmritaEvent,
  type EventType,
  STREAM_ONLY_TYPES,
  eventPayloads,
  isSafeEnvSecretRefName,
  isStreamOnly,
  laneMandateSchema,
  mergeReportSchema,
  newId,
  parseClientMessage,
  parseEvent,
  parseUnsealedEvent,
} from '../src/index.ts';

/** Object-shape keys of a payload schema, unwrapping `.refine`/`.transform`. */
function objectShapeKeys(schema: z.ZodTypeAny): string[] {
  let s: z.ZodTypeAny = schema;
  while (s instanceof z.ZodEffects) s = s.innerType();
  return s instanceof z.ZodObject ? Object.keys(s.shape as Record<string, unknown>) : [];
}

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

describe('secret-ref safety (WO#1.5)', () => {
  it('isSafeEnvSecretRefName accepts env-NAMEs and rejects everything else', () => {
    for (const ok of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'XAI_API_KEY',
      'AMRITA_PROVIDER_X_KEY',
      'A_B',
    ]) {
      expect(isSafeEnvSecretRefName(ok)).toBe(true);
    }
    for (const bad of [
      'lowercase_key', // lowercase
      'NOUNDERSCORE', // no underscore (rejects all-caps secret-value shapes)
      'X', // too short
      '_LEADING', // must start with a letter
      'HAS SPACE',
      'HAS-DASH',
      '',
    ]) {
      expect(isSafeEnvSecretRefName(bad)).toBe(false);
    }
  });

  it('no event payload defines a secret-bearing field name', () => {
    const forbidden = new Set(['secret', 'apikey', 'token', 'password', 'keyvalue']);
    for (const [type, schema] of Object.entries(eventPayloads)) {
      for (const key of objectShapeKeys(schema as z.ZodTypeAny)) {
        const norm = key.toLowerCase().replace(/_/g, '');
        expect(forbidden.has(norm), `${type}.${key} looks secret-bearing`).toBe(false);
      }
    }
  });
});

describe('entity event taxonomy (WO#1.2)', () => {
  const valid: Record<string, unknown> = {
    'task.created': {
      taskId: newId(),
      projectId: newId(),
      conversationId: newId(),
      title: 'fix the PDF export bug',
      status: 'now',
    },
    'decision.recorded': {
      decisionId: newId(),
      projectId: newId(),
      sourceMessageId: newId(),
      text: 'use SQLite + WAL',
    },
    'memory.updated': {
      entryId: newId(),
      scope: 'project',
      content: 'remember the brief',
      projectId: newId(),
      source: 'curated',
    },
    'memory.consolidated': {
      resultEntryId: newId(),
      sourceEntryIds: [newId(), newId()],
      content: 'merged note',
      scope: 'project',
      projectId: newId(),
    },
    'provider.degraded': { provider: 'anthropic', reason: 'credit exhausted' },
    'connector.installed': { connectorId: newId(), slug: 'claude-code', kind: 'cli' },
    'settings.updated': { key: 'theme', value: 'dark' },
    // companion (ADR-0018)
    'brief.updated': {
      projectId: newId(),
      goal: 'ship the CRM',
      audience: 'small agencies',
      successCriteria: ['login works'],
      scope: ['web app'],
      noScope: ['mobile'],
    },
    'question.opened': { questionId: newId(), projectId: newId(), text: 'which auth provider?' },
    'question.resolved': { questionId: newId(), resolution: 'magic links' },
    'question.dropped': { questionId: newId(), reason: 'out of scope' },
    'risk.opened': { riskId: newId(), projectId: newId(), text: 'data loss', severity: 'high' },
    'risk.resolved': { riskId: newId(), resolvedByDecisionId: newId() },
    'milestone.created': {
      milestoneId: newId(),
      projectId: newId(),
      title: 'Alpha',
      targetDate: '2026-07-01',
    },
    'milestone.updated': { milestoneId: newId(), status: 'active', targetDate: null },
    'milestone.completed': { milestoneId: newId() },
  };

  for (const [type, payload] of Object.entries(valid)) {
    it(`round-trips ${type}`, () => {
      const ev = parseEvent(sealed(type as keyof typeof eventPayloads, payload));
      expect(ev.type).toBe(type);
      const again = parseEvent(JSON.parse(JSON.stringify(ev)));
      expect(again).toEqual(ev);
    });
  }

  it('rejects an invalid task.created (missing title, bad status, unknown key)', () => {
    expect(() =>
      parseEvent(sealed('task.created', { taskId: newId(), projectId: newId() })),
    ).toThrow();
    expect(() =>
      parseEvent(
        sealed('task.created', {
          taskId: newId(),
          projectId: newId(),
          title: 'x',
          status: 'bogus',
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEvent(
        sealed('task.created', { taskId: newId(), projectId: newId(), title: 'x', extra: 1 }),
      ),
    ).toThrow();
  });

  it('rejects an invalid decision.superseded (missing supersedesId)', () => {
    expect(() =>
      parseEvent(
        sealed('decision.superseded', { decisionId: newId(), projectId: newId(), text: 'x' }),
      ),
    ).toThrow();
  });

  it('rejects an invalid settings.updated (secret-ish key, missing key)', () => {
    expect(() =>
      parseEvent(sealed('settings.updated', { key: 'openai_api_key', value: 'x' })),
    ).toThrow();
    expect(() =>
      parseEvent(sealed('settings.updated', { key: 'TELEGRAM_BOT_TOKEN', value: 'x' })),
    ).toThrow();
    expect(() => parseEvent(sealed('settings.updated', { value: 'x' }))).toThrow();
  });

  it('accepts a non-secret settings key', () => {
    expect(() =>
      parseEvent(sealed('settings.updated', { key: 'public_url', value: 'https://x' })),
    ).not.toThrow();
  });

  it('rejects a resolution with neither a note nor a decision link (no silent closures)', () => {
    expect(() => parseEvent(sealed('question.resolved', { questionId: newId() }))).toThrow(
      /resolution note or a decision link/,
    );
    expect(() => parseEvent(sealed('risk.resolved', { riskId: newId() }))).toThrow(
      /resolution note or a decision link/,
    );
  });

  it('rejects malformed companion payloads (bad date, bad severity, missing reason)', () => {
    expect(() =>
      parseEvent(
        sealed('milestone.created', {
          milestoneId: newId(),
          projectId: newId(),
          title: 'x',
          targetDate: 'July 1',
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEvent(
        sealed('risk.opened', { riskId: newId(), projectId: newId(), text: 'x', severity: 'huge' }),
      ),
    ).toThrow();
    expect(() => parseEvent(sealed('question.dropped', { questionId: newId() }))).toThrow();
  });

  it('keeps model.delta the only stream-only event across the whole taxonomy', () => {
    expect([...STREAM_ONLY_TYPES]).toEqual(['model.delta']);
    for (const t of Object.keys(eventPayloads) as EventType[]) {
      expect(STREAM_ONLY_TYPES.has(t)).toBe(t === 'model.delta');
      expect(isStreamOnly(t)).toBe(t === 'model.delta');
    }
  });

  it('rejects unknown keys on every new entity payload (strict)', () => {
    for (const [type, payload] of Object.entries(valid)) {
      expect(() =>
        parseEvent(
          sealed(type as keyof typeof eventPayloads, { ...(payload as object), bogusKey: 1 }),
        ),
      ).toThrow();
    }
  });
});
