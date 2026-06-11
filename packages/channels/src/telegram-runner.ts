import type { AmritaKernel } from '@amrita/daemon';
import { TelegramChannel } from './telegram.ts';

/**
 * The live Telegram operator runner (ADR-0021): a long-poll loop over the
 * official Bot API, feeding the owner-gated TelegramChannel. Strictly opt-in:
 * it starts only when `amritad` is launched with `--telegram` AND the bot
 * token env var is present.
 *
 * Secret discipline: the token is read from the environment ONCE, lives only
 * in this closure, and is used solely inside request URLs to api.telegram.org.
 * It is never logged, stored, returned, or echoed in errors.
 */

export type TelegramFetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TelegramRunnerOptions {
  /** Env var NAME holding the bot token. Presence-checked; value never leaves. */
  tokenEnvName?: string;
  /** Owner allowlist of numeric Telegram user ids (deny-by-default). */
  allowedUserIds: number[];
  /** Injectable fetch (tests pass a fake; never hit the network in CI). */
  fetchImpl?: TelegramFetchLike;
  /** Long-poll timeout seconds (Bot API `timeout`). */
  pollTimeoutSec?: number;
  /** Base API URL (tests may override; production default is official). */
  apiBase?: string;
}

export interface RunningTelegramRunner {
  stop(): Promise<void>;
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id: number }; from?: { id: number } };
  callback_query?: { data?: string; from?: { id: number }; message?: { chat?: { id: number } } };
}

/**
 * Start the runner. Throws (with the env NAME only) when the token is absent —
 * an unconfigured runner refuses to start; it never pretends.
 */
export function startTelegramRunner(
  kernel: AmritaKernel,
  opts: TelegramRunnerOptions,
): RunningTelegramRunner {
  const envName = opts.tokenEnvName ?? 'TELEGRAM_BOT_TOKEN';
  const token = process.env[envName];
  if (!token) {
    throw new Error(`telegram runner needs the ${envName} env var (not set; value never logged)`);
  }
  if (opts.allowedUserIds.length === 0) {
    throw new Error(
      'telegram runner refuses to start with an empty owner allowlist (deny-by-default)',
    );
  }
  const fetchImpl: TelegramFetchLike =
    opts.fetchImpl ?? (globalThis.fetch as unknown as TelegramFetchLike);
  const apiBase = opts.apiBase ?? 'https://api.telegram.org';
  const pollTimeout = opts.pollTimeoutSec ?? 25;
  const api = (method: string) => `${apiBase}/bot${token}/${method}`;

  const channel = new TelegramChannel(
    kernel,
    {
      async sendMessage(chatId, text) {
        await fetchImpl(api('sendMessage'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      },
    },
    { allowedUserIds: opts.allowedUserIds },
  );

  let stopped = false;
  let offset = 0;

  const loop = (async () => {
    while (!stopped) {
      try {
        const res = await fetchImpl(`${api('getUpdates')}?timeout=${pollTimeout}&offset=${offset}`);
        if (!res.ok) {
          await delay(2000);
          continue;
        }
        const body = (await res.json()) as { ok?: boolean; result?: TgUpdate[] };
        const updates = body.result ?? [];
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          const normalized = normalize(u);
          if (normalized) await channel.handleUpdate(normalized);
        }
        // Idle breather: with a short/zero poll timeout an empty batch must not
        // busy-spin the event loop.
        if (updates.length === 0 && !stopped) await delay(25);
      } catch {
        // transient network failure: back off, never crash the daemon
        if (!stopped) await delay(2000);
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      await loop;
    },
  };
}

function normalize(
  u: TgUpdate,
): { kind: 'message' | 'callback'; userId: string; chatId: string; text: string } | null {
  if (u.message?.text && u.message.from && u.message.chat) {
    return {
      kind: 'message',
      userId: String(u.message.from.id),
      chatId: String(u.message.chat.id),
      text: u.message.text,
    };
  }
  if (u.callback_query?.data && u.callback_query.from && u.callback_query.message?.chat) {
    return {
      kind: 'callback',
      userId: String(u.callback_query.from.id),
      chatId: String(u.callback_query.message.chat.id),
      text: u.callback_query.data,
    };
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse `AMRITA_TELEGRAM_ALLOWED_IDS` (comma-separated numeric ids). */
export function parseAllowedIds(value: string | undefined): number[] {
  return (value ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}
