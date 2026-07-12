import { type AmritaKernel, isOperatorCommand, runOperatorCommand } from '@amrita/daemon';
import { type ChannelResult, type InboundUpdate, chunkText, safeMessage } from './types.ts';

/**
 * The ONE chat-channel flow (ADR-0037): owner gate → `/pair CODE` → kernel
 * session resolution (one brain) → operator commands (kernel service) → chat
 * turn → chunked replies. Telegram and WhatsApp both delegate here — no
 * channel re-implements a single decision, so every surface answers
 * identically and no memory is duplicated per channel.
 */

export interface ChatChannelFlowOptions {
  /** The protocol channel id this surface records turns under. */
  channelId: 'telegram' | 'whatsapp';
  /** Deny-by-default owner gate over the EXTERNAL user id. */
  isAllowed(userId: string): boolean;
  /** Outbound send (injected; the transport owns tokens, never this module). */
  send(chatId: string, text: string): Promise<void> | void;
  /** Max characters per outbound message. */
  chunkSize: number;
  /** Called when the gate drops an update (diagnostics; never any content). */
  onDenied?(userId: string): void;
}

/** `/pair CODE` → `CODE`, else null. */
function parsePairCommand(text: string): string | null {
  const m = text.trim().match(/^\/pair\s+(\S+)/i);
  return m ? (m[1] ?? null) : null;
}

export async function runChannelUpdate(
  kernel: AmritaKernel,
  opts: ChatChannelFlowOptions,
  update: InboundUpdate,
): Promise<ChannelResult> {
  const channel = opts.channelId;
  const sendChunks = async (chatId: string, text: string): Promise<string[]> => {
    const chunks = chunkText(text, opts.chunkSize);
    for (const c of chunks) await opts.send(chatId, c);
    return chunks;
  };

  // Owner gate — deny-by-default, applies to messages AND callbacks.
  if (!opts.isAllowed(update.userId)) {
    opts.onDenied?.(update.userId);
    return { channel, handled: false, outcome: 'denied', replies: [] };
  }

  const code = parsePairCommand(update.text);
  if (code) {
    try {
      const link = kernel.consumePairing({ channel, code, externalUserId: update.userId });
      const reply = `paired to project ${link.projectId}`;
      await sendChunks(update.chatId, reply);
      return {
        channel,
        handled: true,
        outcome: 'paired',
        ...(link.conversationId ? { conversationId: link.conversationId } : {}),
        replies: [reply],
      };
    } catch (e) {
      const reply = `pairing failed: ${safeMessage(e)}`;
      await sendChunks(update.chatId, reply);
      return { channel, handled: false, outcome: 'error', replies: [reply], error: safeMessage(e) };
    }
  }

  // One brain (R2): the kernel session resolver maps this channel identity
  // into the same store-backed conversation every other surface sees.
  const link = kernel.resolveChannelSession(channel, update.userId);
  if (!link) {
    const reply = 'not linked yet — send: /pair <code>';
    await sendChunks(update.chatId, reply);
    return { channel, handled: true, outcome: 'unpaired', replies: [reply] };
  }

  // Operator commands (ADR-0021/R2): ONE kernel-side interpreter for every surface.
  if (isOperatorCommand(update.text)) {
    const reply = await runOperatorCommand(kernel, update.text.trim(), link.projectId);
    const replies = await sendChunks(update.chatId, reply);
    return {
      channel,
      handled: true,
      outcome: 'command',
      conversationId: link.conversationId,
      replies,
    };
  }

  try {
    const turn = await kernel.runChatTurn({
      conversationId: link.conversationId,
      text: update.text,
      channel,
    });
    const replies = await sendChunks(update.chatId, turn.text ?? '(no reply)');
    return {
      channel,
      handled: true,
      outcome: 'replied',
      conversationId: link.conversationId,
      replies,
    };
  } catch (e) {
    const reply = `error: ${safeMessage(e)}`;
    await sendChunks(update.chatId, reply);
    return { channel, handled: false, outcome: 'error', replies: [reply], error: safeMessage(e) };
  }
}
