import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AmritaEvent,
  type EventType,
  STREAM_ONLY_TYPES,
  connectorManifestSchema,
  connectorStatusReportSchema,
  eventPayloads,
  isProjectDomainEvent,
  isSafeEnvSecretRefName,
  isStreamOnly,
  laneMandateSchema,
  mergeReportSchema,
  newId,
  parseEvent,
  parseRpcResponse,
  parseRpcResult,
  parseUnsealedEvent,
  parseWsServerFrame,
  rpcResultSchemas,
} from '../src/index.ts';

/** Object-shape keys of a payload schema. Under zod 4, `.refine()` no longer
 * wraps in a ZodEffects — a refined object stays a ZodObject — so the only
 * unwrapping still needed is for genuine wrapper types that expose `unwrap()`
 * (optional/nullable/pipe stages), walked defensively. */
function objectShapeKeys(schema: z.ZodTypeAny): string[] {
  let s: z.ZodTypeAny = schema;
  for (let hops = 0; hops < 8 && !(s instanceof z.ZodObject); hops++) {
    const unwrap = (s as { unwrap?: () => z.ZodTypeAny }).unwrap;
    if (typeof unwrap !== 'function') break;
    s = unwrap.call(s);
  }
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

  it('routes durable lane and approval lifecycle project-wide without treating pane output as a projection change', () => {
    expect(isProjectDomainEvent('lane.spawned')).toBe(true);
    expect(isProjectDomainEvent('lane.completed')).toBe(true);
    expect(isProjectDomainEvent('approval.requested')).toBe(true);
    expect(isProjectDomainEvent('lane.progress')).toBe(false);
    expect(isProjectDomainEvent('lane.pane')).toBe(false);
    expect(isProjectDomainEvent('model.delta')).toBe(false);
  });

  it('keeps legacy lane.spawned compatible and accepts bounded idempotency/correlation metadata', () => {
    const laneId = newId();
    const legacy = parseEvent(sealed('lane.spawned', { laneId, kind: 'claude-code' }));
    expect(legacy.type).toBe('lane.spawned');

    const idempotencyKey = `delegate:${newId()}`;
    const groupId = newId();
    const verifiesLaneId = newId();
    const keyed = parseEvent(
      sealed('lane.spawned', {
        laneId: newId(),
        kind: 'codex',
        idempotencyKey,
        groupId,
        role: 'qa',
        verifiesLaneId,
      }),
    );
    expect(keyed.type === 'lane.spawned' && keyed.payload).toMatchObject({
      idempotencyKey,
      groupId,
      role: 'qa',
      verifiesLaneId,
    });

    for (const payload of [
      { laneId: newId(), kind: 'claude-code', idempotencyKey: '' },
      { laneId: newId(), kind: 'claude-code', idempotencyKey: 'x'.repeat(201) },
      { laneId: newId(), kind: 'claude-code', role: 'manager' },
      { laneId: newId(), kind: 'claude-code', groupId: 'not-an-id' },
    ]) {
      expect(() => parseEvent(sealed('lane.spawned', payload))).toThrow();
    }
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

describe('rpc wire contract (ADR-0032)', () => {
  it('terminal frames round-trip and reject junk (ADR-0052)', async () => {
    const { terminalClientFrameSchema, terminalServerFrameSchema } = await import('../src/rpc.ts');
    expect(terminalClientFrameSchema.parse({ t: 'input', data: '\x1b[A' })).toEqual({
      t: 'input',
      data: '\x1b[A',
    });
    expect(terminalClientFrameSchema.parse({ t: 'resize', cols: 120, rows: 32 })).toEqual({
      t: 'resize',
      cols: 120,
      rows: 32,
    });
    expect(() => terminalClientFrameSchema.parse({ t: 'input', data: '' })).toThrow();
    expect(() => terminalClientFrameSchema.parse({ t: 'resize', cols: 5, rows: 2 })).toThrow();
    expect(() => terminalClientFrameSchema.parse({ t: 'exec', cmd: 'rm -rf' })).toThrow();
    expect(terminalServerFrameSchema.parse({ t: 'output', data: 'hi' }).t).toBe('output');
    expect(terminalServerFrameSchema.parse({ t: 'exit', reason: 'ended' }).t).toBe('exit');
  });

  it('parses success and error response envelopes', () => {
    const okFrame = parseRpcResponse({ id: 1, result: { pong: true } });
    expect('error' in okFrame).toBe(false);
    const errFrame = parseRpcResponse({
      id: null,
      error: { code: 'invalid_params', message: 'bad' },
    });
    expect('error' in errFrame).toBe(true);
    expect(() => parseRpcResponse({ id: 1, error: { code: 'nope', message: 'x' } })).toThrow();
  });

  it('parses the real WS frames including `replayed`', () => {
    const ev = parseEvent(sealed('message.user', { text: 'hi' }));
    const frame = parseWsServerFrame({ t: 'event', event: ev });
    expect(frame.t).toBe('event');
    const replayed = parseWsServerFrame({
      t: 'replayed',
      conversationId: ev.conversationId,
      sinceSeq: 1,
    });
    expect(replayed.t).toBe('replayed');
    expect(() => parseWsServerFrame({ t: 'ack', conversationId: newId(), seq: 1 })).toThrow();
  });

  it('parseRpcResult strips undeclared keys and rejects uncovered methods', () => {
    const parsed = parseRpcResult('ping', { pong: true, undeclaredKey: 'dropped' }) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({ pong: true });
    expect(() => parseRpcResult('no.such.method', {})).toThrow(/no result contract/);
  });

  it('declares a result contract for every wire method', () => {
    expect(Object.keys(rpcResultSchemas).length).toBeGreaterThanOrEqual(60);
    for (const [method, schema] of Object.entries(rpcResultSchemas)) {
      expect(method.length, method).toBeGreaterThan(0);
      expect(schema).toBeDefined();
    }
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

  it('keeps the stream-only set to exactly model.delta and lane.pane', () => {
    const streamOnly = ['model.delta', 'lane.pane'];
    expect([...STREAM_ONLY_TYPES]).toEqual(streamOnly);
    for (const t of Object.keys(eventPayloads) as EventType[]) {
      const expected = streamOnly.includes(t);
      expect(STREAM_ONLY_TYPES.has(t)).toBe(expected);
      expect(isStreamOnly(t)).toBe(expected);
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

describe('connector manifests + task provenance (ADR-0022)', () => {
  const githubManifest = {
    slug: 'github',
    kind: 'source',
    title: 'GitHub',
    description: 'issues import',
    capabilities: ['issues.import'],
    requiredEnv: ['GITHUB_TOKEN'],
    setupCommands: ['export GITHUB_TOKEN=<token>'],
  };

  it('accepts a valid manifest and rejects env VALUES, bad slugs, unknown keys', () => {
    expect(connectorManifestSchema.safeParse(githubManifest).success).toBe(true);
    // an env entry that looks like a secret VALUE must not validate
    expect(
      connectorManifestSchema.safeParse({
        ...githubManifest,
        requiredEnv: ['ghp_lowercaseValueShape'],
      }).success,
    ).toBe(false);
    expect(
      connectorManifestSchema.safeParse({ ...githubManifest, slug: 'Bad Slug!' }).success,
    ).toBe(false);
    expect(connectorManifestSchema.safeParse({ ...githubManifest, bogus: 1 }).success).toBe(false);
  });

  it('connector status reports are strict and enumerate honest states only', () => {
    const report = {
      manifest: githubManifest,
      state: 'needs_setup',
      detail: 'missing env',
      missingEnv: ['GITHUB_TOKEN'],
      nextCommand: 'export GITHUB_TOKEN=<token>',
    };
    expect(connectorStatusReportSchema.safeParse(report).success).toBe(true);
    expect(connectorStatusReportSchema.safeParse({ ...report, state: 'ready' }).success).toBe(
      false,
    ); // 'ready' is not a connector state — connected requires a probe
  });

  it('task.created accepts optional externalRef + body and replays old events unchanged', () => {
    const full = parseEvent(
      sealed('task.created', {
        taskId: newId(),
        projectId: newId(),
        title: '#7 · Crash on save',
        body: 'Imported from https://github.com/o/r/issues/7',
        externalRef: 'github:o/r#7',
      }),
    );
    expect(full.type).toBe('task.created');
    // pre-0022 shape (no externalRef/body) still parses — replay compatibility
    expect(() =>
      parseEvent(sealed('task.created', { taskId: newId(), projectId: newId(), title: 'old' })),
    ).not.toThrow();
  });
});
