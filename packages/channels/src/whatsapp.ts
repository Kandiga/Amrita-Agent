import type { AmritaKernel } from '@amrita/daemon';
import { runChannelUpdate } from './base.ts';
import type { Channel, ChannelResult, InboundUpdate } from './types.ts';

/**
 * The WhatsApp channel adapter (ADR-0037) — official Cloud API surface only,
 * honest-integrations rule. Deny-by-default: only allowlisted WhatsApp user
 * ids are processed. The full chat flow (pair → operator commands → chat
 * turns) is the shared handler — identical answers to every other channel.
 *
 * The LIVE webhook runner is NOT bundled yet: WhatsApp Cloud pushes over an
 * HTTPS webhook (endpoint + verify token), a deployment surface of its own.
 * `channels.list` reports whatsapp as needs_setup with the exact env NAMES;
 * nothing here pretends otherwise.
 */

/** Env NAMES the Cloud API integration needs (values never enter Amrita's store). */
export const WHATSAPP_REQUIRED_ENV = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

/** Presence-only config check (never a value). */
export function whatsAppConfigStatus(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean;
  missingEnv: string[];
} {
  const missingEnv = WHATSAPP_REQUIRED_ENV.filter((name) => !env[name]);
  return { configured: missingEnv.length === 0, missingEnv };
}

/** The outbound surface a real WhatsApp integration provides — injected. */
export interface WhatsAppSender {
  sendMessage(chatId: string, text: string): Promise<void> | void;
}

export interface WhatsAppChannelOptions {
  /** Owner allowlist of WhatsApp user ids (wa ids / phone ids). Empty ⇒ nobody. */
  allowedUserIds: string[];
  /** Max characters per outbound message (WhatsApp ~4096). */
  chunkSize?: number;
}

const WHATSAPP_MAX = 4000;

export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp';
  private readonly kernel: AmritaKernel;
  private readonly sender: WhatsAppSender;
  private readonly allowed: Set<string>;
  private readonly chunkSize: number;
  /** Ids dropped by the gate (diagnostics; never any content). */
  readonly droppedUserIds: string[] = [];

  constructor(kernel: AmritaKernel, sender: WhatsAppSender, opts: WhatsAppChannelOptions) {
    this.kernel = kernel;
    this.sender = sender;
    this.allowed = new Set(opts.allowedUserIds);
    this.chunkSize = opts.chunkSize ?? WHATSAPP_MAX;
  }

  async handleUpdate(update: InboundUpdate): Promise<ChannelResult> {
    return runChannelUpdate(
      this.kernel,
      {
        channelId: 'whatsapp',
        isAllowed: (userId) => this.allowed.has(userId),
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
