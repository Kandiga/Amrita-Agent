import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmritaKernel, dispatch, isErrorResponse } from '../src/index.ts';

/**
 * Memory/session invariance (ADR-0019 §4): switching the brain provider/model
 * must never damage Amrita's memory. Project state, conversation history, and
 * per-turn provenance are owned by the event-sourced store — not by any
 * provider — so a switch only changes how the NEXT turn resolves.
 */

let kernel: AmritaKernel;
beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => kernel.close());

async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  const r = await dispatch(kernel, { id: 1, method, params });
  if (isErrorResponse(r)) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.result as T;
}

describe('memory/session invariance across model switches', () => {
  it('one conversation survives a brain switch: history grows, state intact, provenance preserved', async () => {
    const projectId = kernel.ensureProject({ slug: 'inv', name: 'Invariance' }).id;
    const conversationId = kernel.createConversation({ projectId }).id;

    // Project state BEFORE the switch: brief + an open question.
    await call('projects.brief.update', {
      projectId,
      conversationId,
      goal: 'survive the switch',
      successCriteria: ['nothing is lost'],
      scope: [],
      noScope: [],
    });
    await call('projects.questions.open', { projectId, conversationId, text: 'will it hold?' });

    // Turn 1 under provider/model A (no bindings → auto → mock default).
    const turn1 = await kernel.runChatTurn({ conversationId, text: 'first brain', role: 'main' });
    expect(turn1).toMatchObject({ provider: 'mock', model: 'mock-default' });

    // SWITCH the brain for this project (the Settings Hub write path).
    await call('providers.role.set', {
      role: 'main',
      provider: 'mock',
      model: 'brain-b',
      projectId,
    });

    // Turn 2 — SAME conversation, new resolution. No new project/conversation.
    const turn2 = await kernel.runChatTurn({ conversationId, text: 'second brain', role: 'main' });
    expect(turn2).toMatchObject({ provider: 'mock', model: 'brain-b' });
    expect(kernel.listConversations(projectId)).toHaveLength(1);

    // History grew monotonically in one place: u/a/u/a.
    const roles = kernel.store.listMessages(conversationId).map((m) => m.role);
    expect(roles).toEqual(['user', 'agent', 'user', 'agent']);

    // Companion state is untouched by the switch.
    const companion = await call<{
      brief: { goal: string; successCriteria: string[] } | null;
      questions: { text: string; status: string }[];
    }>('projects.companion.get', { projectId });
    expect(companion.brief?.goal).toBe('survive the switch');
    expect(companion.questions[0]).toMatchObject({ text: 'will it hold?', status: 'open' });

    // Per-turn provenance is immutable history: each model.request keeps the
    // provider/model/scope that turn ACTUALLY ran under.
    const requests = kernel
      .listEvents(conversationId)
      .filter((e) => e.type === 'model.request') as unknown as {
      payload: { model: string; via: string };
    }[];
    expect(requests.map((r) => r.payload.model)).toEqual(['mock-default', 'brain-b']);
    expect(requests.map((r) => r.payload.via)).toEqual(['auto', 'project']);

    // The timeline (derived from the log) spans both brains in one project.
    const timeline = await call<{ type: string }[]>('projects.timeline.list', { projectId });
    expect(timeline.filter((e) => e.type === 'model.request')).toHaveLength(2);

    // No provider-side hidden state is needed: replaying events rebuilds the
    // exact same transcript both turns are part of.
    const replayedTexts = kernel
      .listEvents(conversationId)
      .filter((e) => e.type === 'message.user')
      .map((e) => (e.payload as { text: string }).text);
    expect(replayedTexts).toEqual(['first brain', 'second brain']);
  });

  it('a project override never leaks to another project, and clearing falls back without deleting', async () => {
    const a = kernel.ensureProject({ slug: 'proj-a', name: 'A' }).id;
    const b = kernel.ensureProject({ slug: 'proj-b', name: 'B' }).id;
    const convB = kernel.createConversation({ projectId: b }).id;
    kernel.store.recordUserMessage({ projectId: b, conversationId: convB, text: 'b memory' });

    await call('providers.role.set', {
      role: 'main',
      provider: 'mock',
      model: 'a-only',
      projectId: a,
    });
    expect(kernel.resolveRole('main', a)).toMatchObject({ model: 'a-only', via: 'project' });
    expect(kernel.resolveRole('main', b).via).toBe('auto'); // no leak

    // Clearing A's override falls back; B's memory is untouched throughout.
    await call('providers.role.clear', { role: 'main', projectId: a });
    expect(kernel.resolveRole('main', a).via).toBe('auto');
    expect(kernel.store.listMessages(convB).map((m) => m.role)).toEqual(['user']);
  });
});
