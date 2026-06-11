/**
 * The channel layer (Phase 3). A `Channel` turns inbound messages from a surface
 * (web, Telegram, …) into Amrita chat turns and sends replies back. Channels go
 * through the kernel/Store API; they never hold or log a secret/bot token.
 */

/** A normalized inbound update from a channel surface. */
export interface InboundUpdate {
  /** `message` or `callback` (Telegram callback_query). Both are owner-gated. */
  kind: 'message' | 'callback';
  /** External user id (e.g. a Telegram numeric id) as a string. */
  userId: string;
  /** External chat id — where replies are sent. */
  chatId: string;
  /** Text payload (message text or callback data). */
  text: string;
}

export type ChannelOutcome = 'denied' | 'unpaired' | 'paired' | 'replied' | 'command' | 'error';

/** The result of handling one inbound update. Carries no secret value. */
export interface ChannelResult {
  channel: string;
  handled: boolean;
  outcome: ChannelOutcome;
  conversationId?: string;
  /** The reply text chunks that were sent (for inspection/tests). */
  replies: string[];
  error?: string;
}

export interface Channel {
  readonly id: string;
}

/** A safe, value-free error message (no stack, and provider errors are already safe). */
export function safeMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Split text into ordered chunks of at most `maxLen` characters (Telegram caps a
 * message at ~4096). Order is preserved; concatenating the chunks reproduces the
 * input.
 */
export function chunkText(text: string, maxLen: number): string[] {
  if (maxLen <= 0 || text.length <= maxLen) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) out.push(text.slice(i, i + maxLen));
  return out;
}
