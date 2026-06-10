import type { AmritaKernel } from '@amrita/daemon';
import { type Channel, type ChannelResult, safeMessage } from './types.ts';

export interface WebInbound {
  conversationId: string;
  text: string;
  provider?: string;
  model?: string;
}

/**
 * The web channel: a thin adapter mapping web/HTTP clients to the chat-turn path.
 * Context is explicit (the client supplies `conversationId`). Web auth/sessions
 * are a separate concern (deferred); this just runs the turn and returns the reply.
 */
export class WebChannel implements Channel {
  readonly id = 'web';
  private readonly kernel: AmritaKernel;

  constructor(kernel: AmritaKernel) {
    this.kernel = kernel;
  }

  async handle(input: WebInbound): Promise<ChannelResult> {
    try {
      const turn = await this.kernel.runChatTurn({
        conversationId: input.conversationId,
        text: input.text,
        channel: 'web',
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      return {
        channel: 'web',
        handled: true,
        outcome: 'replied',
        conversationId: input.conversationId,
        replies: turn.text ? [turn.text] : [],
      };
    } catch (e) {
      return {
        channel: 'web',
        handled: false,
        outcome: 'error',
        replies: [],
        error: safeMessage(e),
      };
    }
  }
}
