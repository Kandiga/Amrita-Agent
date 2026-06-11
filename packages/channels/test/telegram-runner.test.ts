import { AmritaKernel } from '@amrita/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TelegramFetchLike, parseAllowedIds, startTelegramRunner } from '../src/index.ts';

/**
 * The live runner, driven entirely by an injected fetch — no network, and the
 * token in tests is a clearly-fake placeholder (never a real bot token).
 */

const TOKEN_ENV = 'AMRITA_TEST_TG_TOKEN';
const FAKE_TOKEN = 'fake-telegram-token-for-tests';

let kernel: AmritaKernel;
beforeEach(() => {
  kernel = AmritaKernel.open({ dbPath: ':memory:' });
});
afterEach(() => {
  kernel.close();
  delete process.env[TOKEN_ENV];
});

interface SentMessage {
  chat_id: string;
  text: string;
}

/** A scripted Bot API: serves each updates batch once, then empties. */
function fakeApi(batches: unknown[][]): {
  fetchImpl: TelegramFetchLike;
  sent: SentMessage[];
  calls: string[];
} {
  const sent: SentMessage[] = [];
  const calls: string[] = [];
  const queue = [...batches];
  const fetchImpl: TelegramFetchLike = async (url, init) => {
    calls.push(url);
    if (url.includes('/sendMessage')) {
      sent.push(JSON.parse(init?.body ?? '{}') as SentMessage);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    // getUpdates: serve the next scripted batch (empty when exhausted)
    const result = queue.shift() ?? [];
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  };
  return { fetchImpl, sent, calls };
}

describe('telegram live runner (ADR-0021)', () => {
  it('refuses to start without the token env or with an empty allowlist', () => {
    expect(() =>
      startTelegramRunner(kernel, { tokenEnvName: TOKEN_ENV, allowedUserIds: [42] }),
    ).toThrow(new RegExp(TOKEN_ENV));
    process.env[TOKEN_ENV] = FAKE_TOKEN;
    expect(() =>
      startTelegramRunner(kernel, { tokenEnvName: TOKEN_ENV, allowedUserIds: [] }),
    ).toThrow(/deny-by-default/);
  });

  it('long-polls, dispatches owner messages through the channel, advances offset, stops cleanly', async () => {
    process.env[TOKEN_ENV] = FAKE_TOKEN;
    const projectId = kernel.ensureProject({ slug: 'run', name: 'Run' }).id;
    const conv = kernel.createConversation({ projectId }).id;
    const { code } = kernel.createPairing({
      channel: 'telegram',
      projectId,
      conversationId: conv,
    });

    const { fetchImpl, sent, calls } = fakeApi([
      [
        {
          update_id: 7,
          message: { text: `/pair ${code}`, chat: { id: 100 }, from: { id: 42 } },
        },
        { update_id: 8, message: { text: '/status', chat: { id: 100 }, from: { id: 42 } } },
        // a stranger is silently denied (no reply sent)
        { update_id: 9, message: { text: '/status', chat: { id: 200 }, from: { id: 999 } } },
      ],
    ]);

    const runner = startTelegramRunner(kernel, {
      tokenEnvName: TOKEN_ENV,
      allowedUserIds: [42],
      fetchImpl,
      pollTimeoutSec: 0,
    });
    // let the loop drain the scripted batch
    await new Promise((r) => setTimeout(r, 50));
    await runner.stop();

    // paired, then /status answered — only to the owner chat
    expect(sent.some((m) => m.text.includes('paired to project'))).toBe(true);
    expect(sent.some((m) => m.text.includes('no brief yet'))).toBe(true);
    expect(sent.every((m) => String(m.chat_id) === '100')).toBe(true);

    // offset advanced past the highest update id (no reprocessing)
    const lastPoll = calls.filter((c) => c.includes('getUpdates')).at(-1) ?? '';
    expect(lastPoll).toContain('offset=10');
  });

  it('parseAllowedIds parses a comma list and drops junk', () => {
    expect(parseAllowedIds('42, 17,abc, ,99')).toEqual([42, 17, 99]);
    expect(parseAllowedIds(undefined)).toEqual([]);
  });
});
