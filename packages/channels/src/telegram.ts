import type { AmritaKernel } from '@amrita/daemon';
import { runChannelUpdate } from './base.ts';
import type { Channel, ChannelResult, InboundUpdate } from './types.ts';

/** The outbound surface a real Telegram bot provides — injected (faked in tests). */
export interface TelegramSender {
  sendMessage(chatId: string, text: string, extra?: { approvalId?: string }): Promise<void> | void;
}

export interface TelegramChannelOptions {
  /** Owner allowlist of numeric Telegram user ids. Empty ⇒ nobody (deny-by-default). */
  allowedUserIds: number[];
  /** Max characters per outbound message (Telegram ~4096). */
  chunkSize?: number;
}

const TELEGRAM_MAX = 4000;

/**
 * The Telegram channel. **Deny-by-default**: only allowlisted numeric user ids
 * are processed (messages AND callback queries). The whole chat flow — pairing,
 * operator commands, chat turns, chunked replies — is the SHARED handler
 * (`base.ts`, ADR-0037), so Telegram answers exactly what every other channel
 * answers. The bot token lives in env/config, never in this object, the DB,
 * events, or any output.
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

  /** HARMONY-2: outbound push (approval prompts, digests) — no inbound update. */
  async notify(chatId: string, text: string, extra?: { approvalId?: string }): Promise<void> {
    await this.sender.sendMessage(chatId, text, extra);
  }

  async handleUpdate(update: InboundUpdate): Promise<ChannelResult> {
    return runChannelUpdate(
      this.kernel,
      {
        channelId: 'telegram',
        isAllowed: (userId) => this.allowed.has(Number(userId)),
        send: (chatId, text) => this.sender.sendMessage(chatId, text),
        chunkSize: this.chunkSize,
        onDenied: (userId) => {
          this.droppedUserIds.push(userId);
        },
      },
      update,
    );
  }
}
