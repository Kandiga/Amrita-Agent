import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel, type FetchLike, type FetchResponseLike } from '../src/index.ts';
import { dispatch, isErrorResponse } from '../src/rpc.ts';

/**
 * ADR-0045 — the event explains itself, and the chat knows what you are looking at.
 *
 *   "אם הזזת כרטיס, נוצר אירוע שמספר מי הזיז, מאיזה מצב לאיזה מצב, מתי ולמה."
 *   "פתיחת כרטיס תציג לא רק פרטים, אלא גם למה הוא קיים, מאיזו מטרה, מגבלה,
 *    החלטה או מסמך הוא נגזר."
 *   "אם פתחת סיכון, היא יודעת שאתה מדבר על הסיכון."
 */

let kernel: AmritaKernel;
let ctx: { projectId: string; conversationId: string };

/**
 * Every provider request, in order. It must be an ARRAY, not "the last one":
 * a qualifying turn also fires the SCRIBE (a second provider call, with its own
 * prompt and no system message), which would otherwise overwrite the very thing
 * we came to assert. The chat turn is always request [0].
 */
let requests: Record<string, unknown>[] = [];
const chatRequest = (): Record<string, unknown> => requests[0] ?? {};

const captureAnthropic: FetchLike = async (_url, init): Promise<FetchResponseLike> => {
  requests.push(JSON.parse(String(init?.body ?? '{}')));
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
    async text() {
      return '';
    },
  };
};

beforeEach(() => {
  requests = [];
  process.env.ANTHROPIC_API_KEY = 'placeholder-value-for-tests';
  kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: captureAnthropic });
  const projectId = kernel.ensureProject({ slug: 'f', name: 'Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  ctx = { projectId, conversationId };
  const { accountId } = kernel.connectProviderAccount({
    ...ctx,
    provider: 'anthropic',
    authMode: 'api_key',
  });
  kernel.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
});
afterEach(() => {
  kernel.close();
  for (const n of ['ANTHROPIC_API_KEY']) delete process.env[n];
});

async function rpc(method: string, params: unknown): Promise<unknown> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}|${r.error.message}`);
  return r.result;
}

describe('the event says WHO, FROM WHAT, WHEN and WHY (ADR-0045)', () => {
  it('records the previous state and the reason for the move', async () => {
    const { taskId } = (await rpc('tasks.create', {
      ...ctx,
      title: 'File the permit',
      status: 'now',
      owner: 'Dana',
    })) as { taskId: string };

    kernel.updateTask({
      ...ctx,
      taskId,
      status: 'later',
      owner: 'Casey',
      origin: 'user',
      reason: 'Dana is on leave and the council pushed the date',
    });

    const ev = kernel.listEvents(ctx.conversationId, 0).find((e) => e.type === 'task.updated');
    expect(ev).toBeDefined();
    // WHO
    expect(ev?.origin).toBe('user');
    // WHEN
    expect(ev?.ts).toBeTruthy();
    // FROM → TO
    expect(ev?.payload).toMatchObject({
      status: 'later',
      owner: 'Casey',
      previous: { status: 'now', owner: 'Dana' },
    });
    // WHY
    expect((ev?.payload as { reason?: string }).reason).toMatch(/on leave/i);
  });

  it('records only the fields that actually CHANGED — not a diff of everything', () => {
    const { taskId } = kernel.createTask({ ...ctx, title: 'x', status: 'now', owner: 'Dana' });
    kernel.updateTask({ ...ctx, taskId, status: 'later', owner: 'Dana' }); // owner unchanged

    const ev = kernel.listEvents(ctx.conversationId, 0).find((e) => e.type === 'task.updated');
    const previous = (ev?.payload as { previous?: Record<string, unknown> }).previous;
    expect(previous).toEqual({ status: 'now' });
    expect(previous).not.toHaveProperty('owner');
  });

  it('a card can explain why it exists', () => {
    const { decisionId } = kernel.recordDecision({ ...ctx, text: 'Riverside Park it is' });
    const { taskId } = kernel.createTask({
      ...ctx,
      title: 'Book Riverside Park',
      derivedFrom: [{ kind: 'decision', ref: decisionId, label: 'Riverside Park it is' }],
    });

    const t = kernel.listTasks({ projectId: ctx.projectId }).find((x) => x.id === taskId);
    expect(t?.derivedFrom).toEqual([
      { kind: 'decision', ref: decisionId, label: 'Riverside Park it is' },
    ]);
  });

  it('a card with no derivation says nothing rather than inventing one', () => {
    const { taskId } = kernel.createTask({ ...ctx, title: 'x' });
    expect(
      kernel.listTasks({ projectId: ctx.projectId }).find((t) => t.id === taskId)?.derivedFrom,
    ).toEqual([]);
  });
});

describe('the chat knows what you are looking at (ADR-0045)', () => {
  it('a focused RISK reaches the model as the subject of the conversation', async () => {
    const { riskId } = kernel.openRisk({
      ...ctx,
      text: 'the arts council may veto the beer garden',
      severity: 'high',
    });

    await kernel.runChatTurn({
      conversationId: ctx.conversationId,
      text: 'what do we do about this?',
      provider: 'anthropic',
      focus: { kind: 'risk', ids: [riskId] },
    });

    const system = String(chatRequest().system ?? '');
    expect(system).toContain('What the operator is looking at right now (risk)');
    expect(system).toContain('the arts council may veto the beer garden');
    expect(system).toContain('Assume the conversation is ABOUT these');
  });

  it('several focused TASKS reach the model together — "what is the right order?"', async () => {
    const a = kernel.createTask({ ...ctx, title: 'File the permit', owner: 'Dana' });
    const b = kernel.createTask({ ...ctx, title: 'Book the band' });
    kernel.createTask({ ...ctx, title: 'Not selected' });

    await kernel.runChatTurn({
      conversationId: ctx.conversationId,
      text: 'what is the right order, and what can you take from me?',
      provider: 'anthropic',
      focus: { kind: 'task', ids: [a.taskId, b.taskId] },
    });

    const system = String(chatRequest().system ?? '');
    // The pack lists every task (that is its job). The FOCUS block lists only what
    // the operator actually has selected — that is the distinction being tested.
    const focusBlock = system.slice(system.indexOf('looking at right now'));
    expect(focusBlock).toContain('File the permit');
    expect(focusBlock).toContain('Book the band');
    expect(focusBlock).not.toContain('Not selected');
  });

  it('a focus pointing at nothing renders NOTHING — never an invitation to invent', async () => {
    kernel.createTask({ ...ctx, title: 'real task' });
    await kernel.runChatTurn({
      conversationId: ctx.conversationId,
      text: 'hi',
      provider: 'anthropic',
      focus: { kind: 'risk', ids: ['01KXGVX7HN1BWP3QGFF1BMBXRX'] },
    });
    expect(String(chatRequest().system ?? '')).not.toContain('looking at right now');
  });

  it('no focus → no focus block', async () => {
    kernel.createTask({ ...ctx, title: 'real task' });
    await kernel.runChatTurn({
      conversationId: ctx.conversationId,
      text: 'hi',
      provider: 'anthropic',
    });
    expect(String(chatRequest().system ?? '')).not.toContain('looking at right now');
  });
});
