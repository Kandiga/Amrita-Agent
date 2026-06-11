import type { AmritaEventLite } from './api.ts';
import { RpcError } from './api.ts';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  /** True for an in-progress draft assistant bubble (streamed `model.delta`). */
  pending?: boolean;
}

/** The (projectId, conversationId) envelope every knowledge write carries. */
export interface WriteCtx {
  projectId: string;
  conversationId: string;
}

/** Predominant text direction, for RTL-aware rendering (Hebrew/Arabic → rtl). */
export function textDir(text: string): 'rtl' | 'ltr' {
  return /[֐-׿؀-ۿ܀-߿]/.test(text) ? 'rtl' : 'ltr';
}

/** A value-free error string for the UI — never a stack trace or a secret. */
export function safeErrorMessage(e: unknown): string {
  if (e instanceof RpcError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function formatUsage(u?: { inputTokens: number; outputTokens: number } | null): string {
  return u ? `${u.inputTokens}/${u.outputTokens} tok` : '';
}

const MESSAGE_TYPES: Record<string, ChatMessage['role']> = {
  'message.user': 'user',
  'message.agent': 'agent',
  'message.system': 'system',
};

/** Build a chat transcript from a replayed event list (message.* events only). */
export function messagesFromEvents(events: AmritaEventLite[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const ev of events) {
    const role = MESSAGE_TYPES[ev.type];
    if (!role) continue;
    const text = typeof ev.payload.text === 'string' ? ev.payload.text : '';
    out.push({ id: ev.id, role, text });
  }
  return out;
}
