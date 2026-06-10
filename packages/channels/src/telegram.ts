import type { AmritaKernel } from '@amrita/daemon';
import {
  type Channel,
  type ChannelResult,
  type InboundUpdate,
  chunkText,
  safeMessage,
} from './types.ts';

/** The outbound surface a real Telegram bot provides — injected (faked in tests). */
export interface TelegramSender {
  sendMessage(chatId: string, text: string): Promise<void> | void;
}

export interface TelegramChannelOptions {
  /** Owner allowlist of numeric Telegram user ids. Empty ⇒ nobody (deny-by-default). */
  allowedUserIds: number[];
  /** Max characters per outbound message (Telegram ~4096). */
  chunkSize?: number;
}

const TELEGRAM_MAX = 4000;

/** `/pair CODE` → `CODE`, else null. */
function parsePairCommand(text: string): string | null {
  const m = text.trim().match(/^\/pair\s+(\S+)/i);
  return m ? (m[1] ?? null) : null;
}

/**
 * The Telegram channel skeleton. **Deny-by-default**: only allowlisted numeric
 * user ids are processed, and the gate applies to BOTH messages and callback
 * queries. An allowed owner links a Telegram identity to an Amrita project via a
 * pairing code (`/pair CODE`), after which messages run chat turns whose replies
 * are chunked to Telegram's size limit. No real Telegram API call happens here —
 * the outbound `sender` is injected. The bot token lives in env/config, never in
 * this object, the DB, events, or any output.
 */
export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  private readonly kernel: AmritaKernel;
  private readonly sender: TelegramSender;
  private readonly allowed: Set<number>;
  private readonly chunkSize: number;
  /** Numeric ids dropped by the gate (for diagnostics; never any content). */
  readonly droppedUserIds: string[] = [];

  constructor(kernel: AmritaKernel, sender: TelegramSender, opts: TelegramChannelOptions) {
    this.kernel = kernel;
    this.sender = sender;
    this.allowed = new Set(opts.allowedUserIds);
    this.chunkSize = opts.chunkSize ?? TELEGRAM_MAX;
  }

  async handleUpdate(update: InboundUpdate): Promise<ChannelResult> {
    // Owner gate — deny-by-default, applies to messages AND callbacks.
    if (!this.allowed.has(Number(update.userId))) {
      this.droppedUserIds.push(update.userId);
      return { channel: 'telegram', handled: false, outcome: 'denied', replies: [] };
    }

    const code = parsePairCommand(update.text);
    if (code) {
      try {
        const link = this.kernel.consumePairing({
          channel: 'telegram',
          code,
          externalUserId: update.userId,
        });
        const reply = `paired to project ${link.projectId}`;
        await this.send(update.chatId, [reply]);
        return {
          channel: 'telegram',
          handled: true,
          outcome: 'paired',
          ...(link.conversationId ? { conversationId: link.conversationId } : {}),
          replies: [reply],
        };
      } catch (e) {
        const reply = `pairing failed: ${safeMessage(e)}`;
        await this.send(update.chatId, [reply]);
        return {
          channel: 'telegram',
          handled: false,
          outcome: 'error',
          replies: [reply],
          error: safeMessage(e),
        };
      }
    }

    const link = this.kernel.getChannelLink('telegram', update.userId);
    if (!link?.conversationId) {
      const reply = 'not linked yet — send: /pair <code>';
      await this.send(update.chatId, [reply]);
      return { channel: 'telegram', handled: true, outcome: 'unpaired', replies: [reply] };
    }

    try {
      const turn = await this.kernel.runChatTurn({
        conversationId: link.conversationId,
        text: update.text,
        channel: 'telegram',
      });
      const chunks = chunkText(turn.text ?? '(no reply)', this.chunkSize);
      await this.send(update.chatId, chunks);
      return {
        channel: 'telegram',
        handled: true,
        outcome: 'replied',
        conversationId: link.conversationId,
        replies: chunks,
      };
    } catch (e) {
      const reply = `error: ${safeMessage(e)}`;
      await this.send(update.chatId, [reply]);
      return {
        channel: 'telegram',
        handled: false,
        outcome: 'error',
        replies: [reply],
        error: safeMessage(e),
      };
    }
  }

  /** Send chunks in order (await each so Telegram message order is preserved). */
  private async send(chatId: string, chunks: string[]): Promise<void> {
    for (const c of chunks) {
      await this.sender.sendMessage(chatId, c);
    }
  }
}
