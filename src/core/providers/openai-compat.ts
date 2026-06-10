import type {
  ChatMessage,
  ChatRequest,
  Provider,
  ProviderProfile,
  ProviderStreamEvent,
} from '../../shared/types.ts';
import { getSecret } from '../../shared/config.ts';
import { sseData } from './sse.ts';

/**
 * One adapter covers OpenAI, OpenRouter, xAI, Groq, DeepSeek, Ollama,
 * llama.cpp, vLLM — anything speaking /chat/completions.
 */

function toOpenAiMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.arguments) },
            }))
          : undefined,
      });
    } else if (m.role === 'tool') {
      for (const r of m.toolResults ?? []) {
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

export function openAiCompatProvider(profile: ProviderProfile): Provider {
  return {
    profile,
    async *chat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const key = profile.keyEnv ? getSecret(profile.keyEnv) : null;
      if (profile.authMode === 'api_key' && !key) {
        yield { type: 'error', message: `Missing API key (${profile.keyEnv}). Run: amrita setup` };
        return;
      }
      const body = {
        model: req.model,
        stream: true,
        max_tokens: req.maxTokens,
        messages: toOpenAiMessages(req.system, req.messages),
        tools: req.tools.length
          ? req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            }))
          : undefined,
      };
      const res = await fetch(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        yield { type: 'error', message: `${profile.id} ${res.status}: ${text.slice(0, 400)}` };
        return;
      }

      // Tool calls stream as fragments keyed by index.
      const pending = new Map<number, { id: string; name: string; args: string }>();
      let finish: string | null = null;

      for await (const data of sseData(res.body)) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = (event.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) continue;
        const delta = choice.delta as
          | {
              content?: string;
              tool_calls?: {
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            }
          | undefined;
        if (delta?.content) yield { type: 'text', delta: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const entry = pending.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          pending.set(tc.index, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason as string;
      }

      for (const [, entry] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try {
          // Local models sometimes emit imperfect JSON — repair the common cases.
          args = entry.args ? JSON.parse(entry.args) : {};
        } catch {
          try {
            args = JSON.parse(entry.args.replace(/,\s*}$/, '}').replace(/'/g, '"'));
          } catch {
            args = { _raw: entry.args };
          }
        }
        yield {
          type: 'tool-call',
          call: { id: entry.id || `call_${Math.random().toString(36).slice(2)}`, name: entry.name, arguments: args },
        };
      }
      yield {
        type: 'stop',
        reason: finish === 'tool_calls' ? 'tool-use' : finish === 'length' ? 'max-tokens' : 'end',
      };
    },
  };
}
