import { afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_PACK_SETTING } from '../src/context-pack.ts';
import { AmritaKernel, type FetchLike, type FetchResponseLike } from '../src/index.ts';

/**
 * The end-to-end proof of ADR-0044 slice 1: the Project Context Pack actually
 * reaches the model on a real chat turn, through the real provider adapter.
 *
 * Asserted on the WIRE (the Anthropic request body), not on an internal call —
 * because the whole bug being fixed was that project state never left the store.
 */

let kernel: AmritaKernel;
afterEach(() => {
  kernel?.close();
  for (const name of ['ANTHROPIC_API_KEY']) delete process.env[name];
});

/** Capture the outgoing provider request body and answer with a valid reply. */
function captureAnthropic(seen: { body?: Record<string, unknown> }): FetchLike {
  return async (_url, init): Promise<FetchResponseLike> => {
    seen.body = JSON.parse(String(init?.body ?? '{}'));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          content: [{ type: 'text', text: 'understood' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
      async text() {
        return '';
      },
    };
  };
}

function openKernel(seen: { body?: Record<string, unknown> }): {
  projectId: string;
  conversationId: string;
} {
  process.env.ANTHROPIC_API_KEY = 'placeholder-value-for-tests';
  kernel = AmritaKernel.open({ dbPath: ':memory:', fetchImpl: captureAnthropic(seen) });
  const projectId = kernel.ensureProject({ slug: 'festival', name: 'Unity Festival' }).id;
  const conversationId = kernel.createConversation({ projectId }).id;
  const { accountId } = kernel.connectProviderAccount({
    projectId,
    conversationId,
    provider: 'anthropic',
    authMode: 'api_key',
  });
  kernel.bindAccountSecretRef(accountId, 'ANTHROPIC_API_KEY');
  return { projectId, conversationId };
}

describe('the context pack reaches the model (ADR-0044)', () => {
  it('sends live project state as the system prompt — she is finally project-aware', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { projectId, conversationId } = openKernel(seen);
    const c = { projectId, conversationId };

    kernel.upsertBrief({
      ...c,
      goal: 'Run the Unity Festival',
      successCriteria: ['500 attendees'],
      scope: [],
      noScope: [],
    });
    kernel.createTask({ ...c, title: 'File the park permit' });
    kernel.openRisk({ ...c, text: 'the permit may not clear in time', severity: 'high' });

    await kernel.runChatTurn({ conversationId, text: "what's left?", provider: 'anthropic' });

    // Anthropic lifts system-role messages into the `system` param — so the pack
    // is genuinely on the wire, not just in a local array.
    const system = String(seen.body?.system ?? '');
    expect(system).toContain('Run the Unity Festival');
    expect(system).toContain('File the park permit');
    expect(system).toContain('the permit may not clear in time');
    expect(system).toContain('500 attendees');
  });

  it('reflects a change made OUTSIDE the conversation on the very next turn', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { projectId, conversationId } = openKernel(seen);
    const c = { projectId, conversationId };
    kernel.upsertBrief({ ...c, goal: 'Ship v1', successCriteria: [], scope: [], noScope: [] });

    await kernel.runChatTurn({ conversationId, text: 'hi', provider: 'anthropic' });
    expect(String(seen.body?.system)).not.toContain('Order the tents');

    // A task created by ANY writer (a board drag, the CLI, Telegram) — no second
    // chat message, no cache to invalidate.
    kernel.createTask({ ...c, title: 'Order the tents' });

    await kernel.runChatTurn({ conversationId, text: 'and now?', provider: 'anthropic' });
    expect(String(seen.body?.system)).toContain('Order the tents');
  });

  it('is NOT persisted — the event log stays byte-identical to the pre-pack world', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { projectId, conversationId } = openKernel(seen);
    kernel.upsertBrief({
      projectId,
      conversationId,
      goal: 'Ship v1',
      successCriteria: [],
      scope: [],
      noScope: [],
    });

    await kernel.runChatTurn({ conversationId, text: 'hi', provider: 'anthropic' });

    // The pack is derived and rebuilt every turn; persisting it would pollute the
    // transcript and be replayed into the store on rebuild.
    const events = kernel.listEvents(conversationId, 0);
    expect(events.filter((e) => e.type === 'message.system')).toHaveLength(0);
    const messages = kernel.store.listMessages(conversationId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'agent']);
  });

  it('degrades to exactly the old behavior when the kill-switch is off', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { projectId, conversationId } = openKernel(seen);
    const c = { projectId, conversationId };
    kernel.upsertBrief({
      ...c,
      goal: 'Run the Unity Festival',
      successCriteria: [],
      scope: [],
      noScope: [],
    });
    kernel.updateSetting({ ...c, key: CONTEXT_PACK_SETTING, value: false });

    await kernel.runChatTurn({ conversationId, text: 'hi', provider: 'anthropic' });

    expect(seen.body?.system).toBeUndefined();
    const msgs = (seen.body?.messages ?? []) as { role: string }[];
    expect(msgs.every((m) => m.role !== 'system')).toBe(true);
  });

  it('still tells her about the live canvas on a brand-new project, but no project state', async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const { conversationId } = openKernel(seen);
    await kernel.runChatTurn({ conversationId, text: 'build me a game', provider: 'anthropic' });
    const system = String(seen.body?.system ?? '');
    // CANVAS-1: the canvas capability is always present, so "build me a game" on a
    // fresh project lands on the canvas instead of files + http.server.
    expect(system).toContain('live canvas');
    expect(system).toContain('```html');
    // …but there is no invented project state.
    expect(system).not.toContain('## Charter');
    expect(system).not.toContain('## Tasks');
  });
});
