import { afterEach, describe, expect, it } from 'vitest';
import { AmritaKernel, type FetchLike, type FetchResponseLike } from '../src/index.ts';
import {
  MAX_AUTO_QUESTIONS_PER_TURN,
  SCRIBE_AUTO_OPEN_QUESTIONS_SETTING,
  SCRIBE_SETTING,
  buildScribePrompt,
  looksLikeProjectTruth,
  parseScribeResponse,
} from '../src/scribe.ts';

describe('scribe response parsing (ADR-0044)', () => {
  it('parses a clean proposal set', () => {
    const out = parseScribeResponse(
      JSON.stringify({
        proposals: [
          {
            kind: 'task',
            title: 'Pay the deposit',
            rationale: 'a date was set',
            confidence: 'high',
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'task', title: 'Pay the deposit' });
  });

  it('digs the JSON out of a fenced block with prose around it', () => {
    const out = parseScribeResponse(
      'Sure! Here is what I found:\n```json\n{"proposals":[{"kind":"risk","text":"rain","severity":"high","rationale":"outdoor event","confidence":"medium"}]}\n```\nHope that helps.',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'risk', severity: 'high' });
  });

  it('returns NOTHING for unparseable output — it never guesses', () => {
    expect(parseScribeResponse('I think you should probably pay the deposit soon.')).toEqual([]);
    expect(parseScribeResponse('')).toEqual([]);
    expect(parseScribeResponse('{ this is not json')).toEqual([]);
  });

  it('DROPS an invalid proposal but keeps the valid ones', () => {
    const out = parseScribeResponse(
      JSON.stringify({
        proposals: [
          { kind: 'task' }, // no title, no rationale → invalid
          { kind: 'nonsense', text: 'x' }, // unknown kind → invalid
          {
            kind: 'question',
            text: 'who signs?',
            rationale: 'nobody named an owner',
            confidence: 'high',
          },
        ],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'question' });
  });

  it('rejects a proposal carrying an unknown key (strict)', () => {
    const out = parseScribeResponse(
      JSON.stringify({
        proposals: [
          {
            kind: 'task',
            title: 'x',
            rationale: 'y',
            confidence: 'high',
            sneaky: 'extra',
          },
        ],
      }),
    );
    expect(out).toEqual([]);
  });
});

describe('scribe plausibility gate', () => {
  it('skips small talk — the fast role can be a CLI subprocess, so this matters', () => {
    expect(looksLikeProjectTruth('thanks!', 'You are welcome.')).toBe(false);
    expect(looksLikeProjectTruth('hi', 'Hello!')).toBe(false);
  });

  it('fires on commitments, dates, money, risk and questions', () => {
    expect(
      looksLikeProjectTruth(
        'the venue deposit is due March 3rd and Dana needs to pay it',
        'Understood, I will note that.',
      ),
    ).toBe(true);
    expect(
      looksLikeProjectTruth('who is going to sign the permit though?', 'Good question — unclear.'),
    ).toBe(true);
  });
});

describe('scribe prompt', () => {
  it('tells the model to return an empty set when nothing happened', () => {
    const p = buildScribePrompt({ contextPack: '', userText: 'hi', agentText: 'hello' });
    expect(p).toContain('{"proposals": []}');
    expect(p).toContain('Do not infer, do not invent');
  });

  it('includes the project state so it cannot re-propose known facts', () => {
    const p = buildScribePrompt({
      contextPack: '# Project: Unity Festival\n## Charter\n- Goal: run it',
      userText: 'x',
      agentText: 'y',
    });
    expect(p).toContain('Unity Festival');
    expect(p).toContain('do not re-propose what is already known');
  });
});

// ── the auto-commit boundary, end to end ─────────────────────────────────────

let kernel: AmritaKernel;
afterEach(() => {
  kernel?.close();
  for (const name of ['ANTHROPIC_API_KEY']) delete process.env[name];
});

/** Answer the chat turn, then answer the Scribe with `scribeReply`. */
function fakeProvider(
  scribeReply: string,
  chatReply = 'Noted — the deposit is due March 3rd.',
): FetchLike {
  let call = 0;
  return async (_url, _init): Promise<FetchResponseLike> => {
    call++;
    const text = call === 1 ? chatReply : scribeReply;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 5 },
        };
      },
      async text() {
        return '';
      },
    };
  };
}

function open(
  scribeReply: string,
  chatReply?: string,
): { projectId: string; conversationId: string } {
  process.env.ANTHROPIC_API_KEY = 'placeholder-value-for-tests';
  kernel = AmritaKernel.open({
    dbPath: ':memory:',
    fetchImpl: fakeProvider(scribeReply, chatReply),
  });
  const projectId = kernel.ensureProject({ slug: 'f', name: 'Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  const { accountId } = kernel.connectProviderAccount({
    projectId,
    conversationId,
    provider: 'anthropic',
    authMode: 'api_key',
  });
  kernel.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
  kernel.setRoleBinding({ role: 'fast', provider: 'anthropic' });
  return { projectId, conversationId };
}

const COMMIT_TEXT = 'the venue deposit is due March 3rd and we need to pay it';

describe('the scribe writes proposals, not truth (ADR-0044)', () => {
  it('queues an asserting proposal (a task) into the Inbox — NOT into tasks', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [
          {
            kind: 'task',
            title: 'Pay the venue deposit',
            rationale: 'the operator committed to March 3rd',
            confidence: 'high',
          },
        ],
      }),
    );

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    // it became a PROPOSAL…
    const inbox = kernel.listInbox({ projectId, status: 'pending' });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      origin: 'agent',
      suggestedKind: 'task',
      confidence: 'high',
    });
    expect(inbox[0]?.rationale).toContain('March 3rd');
    // …and NOT project truth
    expect(kernel.listTasks({ projectId })).toHaveLength(0);
  });

  it('carries provenance back to the exact turn that produced it', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [
          { kind: 'task', title: 'Pay the deposit', rationale: 'committed', confidence: 'high' },
        ],
      }),
    );
    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });
    const item = kernel.listInbox({ projectId })[0];
    expect(item?.sourceMessageId).toBeTruthy();
  });

  it('AUTO-OPENS a question — the one inert item, so the interview flows', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [
          {
            kind: 'question',
            text: 'who signs the permit?',
            rationale: 'no owner was named',
            confidence: 'high',
          },
        ],
      }),
    );

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    const questions = kernel.listQuestions({ projectId, status: 'open' });
    expect(questions).toHaveLength(1);
    expect(questions[0]?.text).toBe('who signs the permit?');
    expect(questions[0]?.sourceMessageId).toBeTruthy(); // provenance is mandatory
    expect(kernel.listInbox({ projectId, status: 'pending' })).toHaveLength(0);
  });

  it('emits question.opened and NO OTHER domain event — the boundary, as a test', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [
          { kind: 'question', text: 'who signs?', rationale: 'r', confidence: 'high' },
          { kind: 'task', title: 'Pay it', rationale: 'r', confidence: 'high' },
          { kind: 'risk', text: 'rain', rationale: 'r', confidence: 'high' },
          { kind: 'decision', text: 'Riverside Park', rationale: 'r', confidence: 'high' },
          { kind: 'milestone', title: 'Permits', rationale: 'r', confidence: 'high' },
          { kind: 'memory', content: 'vendor prefers cash', rationale: 'r', confidence: 'high' },
        ],
      }),
    );

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    const types = kernel.listEvents(conversationId, 0).map((e) => e.type);
    // the ONLY asserting domain write the Scribe may perform
    expect(types).toContain('question.opened');
    // everything that ASSERTS something stayed a proposal
    for (const forbidden of [
      'task.created',
      'risk.opened',
      'decision.recorded',
      'milestone.created',
      'memory.updated',
    ]) {
      expect(types).not.toContain(forbidden);
    }
    expect(kernel.listInbox({ projectId, status: 'pending' })).toHaveLength(5);
  });

  it('caps auto-opened questions per turn — an over-eager Scribe cannot flood the register', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      kind: 'question' as const,
      text: `question number ${i}?`,
      rationale: 'r',
      confidence: 'high' as const,
    }));
    const { projectId, conversationId } = open(JSON.stringify({ proposals: many }));

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    expect(kernel.listQuestions({ projectId, status: 'open' })).toHaveLength(
      MAX_AUTO_QUESTIONS_PER_TURN,
    );
    // the overflow is not lost — it queues for triage
    expect(kernel.listInbox({ projectId, status: 'pending' })).toHaveLength(
      6 - MAX_AUTO_QUESTIONS_PER_TURN,
    );
  });

  it('does not re-open a question that is already open (dedup)', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [
          { kind: 'question', text: 'Who signs the permit?', rationale: 'r', confidence: 'high' },
        ],
      }),
    );
    kernel.openQuestion({ projectId, conversationId, text: 'who signs the permit?' });

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    expect(kernel.listQuestions({ projectId, status: 'open' })).toHaveLength(1);
    // it queued instead of duplicating
    expect(kernel.listInbox({ projectId, status: 'pending' })).toHaveLength(1);
  });

  it('queues questions instead of opening them when auto-open is switched off', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [{ kind: 'question', text: 'who signs?', rationale: 'r', confidence: 'high' }],
      }),
    );
    kernel.updateSetting({
      projectId,
      conversationId,
      key: SCRIBE_AUTO_OPEN_QUESTIONS_SETTING,
      value: false,
    });

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    expect(kernel.listQuestions({ projectId, status: 'open' })).toHaveLength(0);
    expect(kernel.listInbox({ projectId, status: 'pending' })).toHaveLength(1);
  });

  it('does nothing at all when the scribe is switched off', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [{ kind: 'task', title: 'x', rationale: 'r', confidence: 'high' }],
      }),
    );
    kernel.updateSetting({ projectId, conversationId, key: SCRIBE_SETTING, value: false });

    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });

    expect(kernel.listInbox({ projectId })).toHaveLength(0);
  });

  it('a broken Scribe reply never breaks the turn', async () => {
    const { projectId, conversationId } = open('not json at all, sorry');

    const turn = await kernel.runChatTurn({
      conversationId,
      text: COMMIT_TEXT,
      provider: 'anthropic',
    });

    expect(turn.text).toBe('Noted — the deposit is due March 3rd.'); // the reply still landed
    expect(kernel.listInbox({ projectId })).toHaveLength(0);
  });

  it('skips small talk entirely — the Scribe is never even called', async () => {
    // Both sides of the exchange are bland: the gate reads user AND agent text,
    // so an innocuous reply must not drag a "thanks!" turn into a Scribe pass.
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [{ kind: 'task', title: 'x', rationale: 'r', confidence: 'high' }],
      }),
      'You are welcome.',
    );
    await kernel.runChatTurn({ conversationId, text: 'thanks!', provider: 'anthropic' });
    expect(kernel.listInbox({ projectId })).toHaveLength(0);
    expect(kernel.listQuestions({ projectId })).toHaveLength(0);
  });
});

describe('triage promotes into the REAL aggregate (ADR-0044)', () => {
  it('turns a pending task proposal into an actual task, with provenance', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [
          {
            kind: 'task',
            title: 'Pay the venue deposit',
            rationale: 'committed to March 3rd',
            confidence: 'high',
          },
        ],
      }),
    );
    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });
    const item = kernel.listInbox({ projectId, status: 'pending' })[0];
    expect(item).toBeDefined();
    if (!item) return;

    const out = kernel.triageInbox({
      projectId,
      conversationId,
      itemId: item.id,
      kind: 'task',
      title: 'Pay the venue deposit',
    });

    const tasks = kernel.listTasks({ projectId });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(out.promotedId);
    // provenance survives the promotion: the TASK points back at the message
    expect(tasks[0]?.sourceMessageId).toBe(item.sourceMessageId);

    const settled = kernel.listInbox({ projectId }).find((i) => i.id === item.id);
    expect(settled?.status).toBe('triaged');
    expect(settled?.promotedId).toBe(out.promotedId);
    expect(kernel.listInbox({ projectId, status: 'pending' })).toHaveLength(0);
  });

  it('refuses to triage the same item twice', async () => {
    const { projectId, conversationId } = open(
      JSON.stringify({
        proposals: [{ kind: 'task', title: 'x', rationale: 'r', confidence: 'high' }],
      }),
    );
    await kernel.runChatTurn({ conversationId, text: COMMIT_TEXT, provider: 'anthropic' });
    const item = kernel.listInbox({ projectId, status: 'pending' })[0];
    if (!item) throw new Error('no item');

    kernel.triageInbox({ projectId, conversationId, itemId: item.id, kind: 'task', title: 'x' });
    expect(() =>
      kernel.triageInbox({ projectId, conversationId, itemId: item.id, kind: 'task', title: 'x' }),
    ).toThrow(/already triaged/);
    expect(kernel.listTasks({ projectId })).toHaveLength(1); // not duplicated
  });
});
