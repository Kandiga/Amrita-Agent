import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
} from '../../shared/types.ts';
import { getSecret, loadConfig } from '../../shared/config.ts';
import { log } from '../../shared/util.ts';

/**
 * Authorization: Telegram exposes shell/file tools, so the bot is owner-only.
 * Deny-by-default — if no allowlist is configured, every user is rejected
 * (the owner must add their numeric id to channels.telegram.allowedUserIds).
 */
export function telegramUserAllowed(userId: number | undefined): boolean {
  if (userId === undefined) return false;
  const ids = loadConfig().channels.telegram.allowedUserIds;
  return ids.length > 0 && ids.includes(userId);
}

/**
 * Telegram channel via the raw Bot API (long-polling — no inbound ports,
 * no webhook, no dependencies). Inline keyboards power /projects switching;
 * callback_query data is routed into the gateway as a normal command.
 */

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { chat: { id: number } };
    data?: string;
  };
}

const MAX_MESSAGE = 4000; // Telegram limit is 4096 UTF-16 units; keep margin.

export function telegramAdapter(): ChannelAdapter {
  let running = false;
  let offset = 0;

  function token(): string {
    const t = getSecret('TELEGRAM_BOT_TOKEN');
    if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set (amrita setup)');
    return t;
  }

  async function api(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(65_000),
    });
    const data = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  /** Telegram MarkdownV2 is strict; degrade to plain text on parse errors. */
  async function sendChunk(chatId: string, text: string, markdown: boolean, keyboard?: unknown) {
    const payload: Record<string, unknown> = { chat_id: Number(chatId), text };
    if (keyboard) payload.reply_markup = keyboard;
    if (markdown) payload.parse_mode = 'Markdown';
    try {
      await api('sendMessage', payload);
    } catch {
      delete payload.parse_mode;
      await api('sendMessage', payload);
    }
  }

  return {
    name: 'telegram',
    capabilities: { buttons: true, streaming: false, lanes: false },

    async start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void> {
      // Validate token before looping.
      const me = (await api('getMe', {})) as { username?: string };
      log('telegram', `connected as @${me.username}`);
      if (loadConfig().channels.telegram.allowedUserIds.length === 0) {
        log(
          'telegram',
          'WARNING: channels.telegram.allowedUserIds is empty — all users are denied. Add your numeric Telegram id to authorize.',
        );
      }
      await api('setMyCommands', {
        commands: [
          { command: 'projects', description: 'Switch to a project' },
          { command: 'main', description: 'Back to main Amrita' },
          { command: 'new', description: 'Fresh conversation' },
          { command: 'where', description: 'Show current context' },
          { command: 'sessions', description: 'Recent sessions' },
          { command: 'stop', description: 'Interrupt current work' },
        ],
      }).catch(() => {});

      running = true;
      void (async () => {
        while (running) {
          try {
            const updates = (await api('getUpdates', {
              offset,
              timeout: 50,
              allowed_updates: ['message', 'callback_query'],
            })) as TgUpdate[];
            for (const update of updates) {
              offset = Math.max(offset, update.update_id + 1);
              if (update.message?.text) {
                const fromId = update.message.from?.id;
                if (!telegramUserAllowed(fromId)) {
                  log('telegram', `dropped message from unauthorized user ${fromId ?? '?'}`);
                  continue;
                }
                // Handle each message without blocking the poll loop.
                void onMessage({
                  channel: 'telegram',
                  chatId: String(update.message.chat.id),
                  userId: String(fromId ?? ''),
                  text: update.message.text,
                }).catch((err) => log('telegram', `handler error: ${err}`));
              } else if (update.callback_query) {
                const cb = update.callback_query;
                void api('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
                if (!telegramUserAllowed(cb.from.id)) {
                  log('telegram', `dropped callback from unauthorized user ${cb.from.id}`);
                  continue;
                }
                if (cb.data && cb.message) {
                  void onMessage({
                    channel: 'telegram',
                    chatId: String(cb.message.chat.id),
                    userId: String(cb.from.id),
                    text: cb.data,
                  }).catch((err) => log('telegram', `callback error: ${err}`));
                }
              }
            }
          } catch (err) {
            if (running) {
              log('telegram', `poll error: ${err instanceof Error ? err.message : err}`);
              await new Promise((r) => setTimeout(r, 5000));
            }
          }
        }
      })();
    },

    async stop(): Promise<void> {
      running = false;
    },

    async send(chatId: string, message: OutboundMessage): Promise<void> {
      const keyboard = message.buttons
        ? {
            inline_keyboard: message.buttons.map((row) =>
              row.map((b) => ({ text: b.label, callback_data: b.action })),
            ),
          }
        : undefined;
      // Chunk long messages safely.
      const text = message.text;
      for (let i = 0; i < text.length; i += MAX_MESSAGE) {
        const chunk = text.slice(i, i + MAX_MESSAGE);
        const isLast = i + MAX_MESSAGE >= text.length;
        await sendChunk(chatId, chunk, message.markdown ?? false, isLast ? keyboard : undefined);
      }
    },
  };
}
