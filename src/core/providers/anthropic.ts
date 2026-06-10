import type {
  ChatMessage,
  ChatRequest,
  Provider,
  ProviderProfile,
  ProviderStreamEvent,
  ToolCall,
} from '../../shared/types.ts';
import { getSecret } from '../../shared/config.ts';
import { sseData } from './sse.ts';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicMessages(messages: ChatMessage[]): { role: string; content: AnthropicBlock[] }[] {
  const out: { role: string; content: AnthropicBlock[] }[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (m.role === 'tool') {
      const blocks: AnthropicBlock[] = (m.toolResults ?? []).map((r) => ({
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content,
        is_error: r.isError,
      }));
      if (blocks.length) out.push({ role: 'user', content: blocks });
    } else if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    }
  }
  return out;
}

export function anthropicProvider(profile: ProviderProfile): Provider {
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
        max_tokens: req.maxTokens,
        system: req.system,
        stream: true,
        messages: toAnthropicMessages(req.messages),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      };
      const res = await fetch(`${profile.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        yield { type: 'error', message: `Anthropic ${res.status}: ${text.slice(0, 400)}` };
        return;
      }

      let stopReason: 'end' | 'tool-use' | 'max-tokens' = 'end';
      // tool_use blocks stream their JSON input incrementally; accumulate per block index.
      const pendingTools = new Map<number, { id: string; name: string; json: string }>();

      for await (const data of sseData(res.body)) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        const type = event.type as string;
        if (type === 'content_block_start') {
          const block = event.content_block as { type: string; id?: string; name?: string };
          if (block.type === 'tool_use') {
            pendingTools.set(event.index as number, {
              id: block.id ?? '',
              name: block.name ?? '',
              json: '',
            });
          }
        } else if (type === 'content_block_delta') {
          const delta = event.delta as { type: string; text?: string; partial_json?: string };
          if (delta.type === 'text_delta' && delta.text) {
            yield { type: 'text', delta: delta.text };
          } else if (delta.type === 'input_json_delta') {
            const pending = pendingTools.get(event.index as number);
            if (pending) pending.json += delta.partial_json ?? '';
          }
        } else if (type === 'content_block_stop') {
          const pending = pendingTools.get(event.index as number);
          if (pending) {
            pendingTools.delete(event.index as number);
            let args: Record<string, unknown> = {};
            try {
              args = pending.json ? JSON.parse(pending.json) : {};
            } catch {
              args = { _raw: pending.json };
            }
            const call: ToolCall = { id: pending.id, name: pending.name, arguments: args };
            yield { type: 'tool-call', call };
          }
        } else if (type === 'message_delta') {
          const delta = event.delta as { stop_reason?: string };
          if (delta.stop_reason === 'tool_use') stopReason = 'tool-use';
          else if (delta.stop_reason === 'max_tokens') stopReason = 'max-tokens';
        } else if (type === 'error') {
          const err = event.error as { message?: string } | undefined;
          yield { type: 'error', message: err?.message ?? 'stream error' };
          return;
        }
      }
      yield { type: 'stop', reason: stopReason };
    },
  };
}
