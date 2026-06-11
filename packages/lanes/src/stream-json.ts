import type { Usage } from '@amrita/protocol';

/**
 * Tolerant parser for Claude Code's `--output-format stream-json` output: one
 * JSON object per line (NDJSON). We only extract what a lane needs — progress
 * notes, assistant-turn counts, and the final usage/summary — and **ignore
 * everything we don't understand**. A non-JSON or unexpected line yields `null`
 * and never throws, so a format drift can't crash a lane.
 */
export interface StreamJsonEvent {
  /** A human-readable progress note (forwarded to `lane.progress`). */
  note?: string;
  /** Present on the terminal `result` event. */
  usage?: Usage;
  summary?: string;
  /** True for an assistant message (counts toward the turn budget). */
  turn?: boolean;
  /** True for the terminal `result` event. */
  isResult?: boolean;
}

/** Normalize a Claude usage blob (snake_case) to the protocol `Usage`. */
export function normalizeClaudeUsage(raw: unknown, usd?: number): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : 0;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : 0;
  return { inputTokens: input, outputTokens: output, ...(typeof usd === 'number' ? { usd } : {}) };
}

function assistantText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join(' ')
    .trim();
}

/** Parse one NDJSON line. Returns `null` for blank/non-JSON/unrecognized lines. */
export function parseStreamJsonLine(line: string): StreamJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null; // tolerate non-JSON lines
  }

  switch (obj.type) {
    case 'system': {
      const subtype = typeof obj.subtype === 'string' ? obj.subtype : 'event';
      return { note: `session ${subtype}` };
    }
    case 'assistant': {
      const text = assistantText(obj.message);
      return { turn: true, note: text ? `assistant: ${text.slice(0, 160)}` : 'assistant turn' };
    }
    case 'user':
      return { note: 'tool result received' };
    case 'result': {
      const usd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined;
      return {
        isResult: true,
        usage: normalizeClaudeUsage(obj.usage, usd),
        ...(typeof obj.result === 'string' ? { summary: obj.result } : {}),
      };
    }
    default:
      return null;
  }
}
