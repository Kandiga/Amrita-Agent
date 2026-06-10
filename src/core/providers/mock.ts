import type {
  ChatRequest,
  Provider,
  ProviderProfile,
  ProviderStreamEvent,
} from '../../shared/types.ts';

/**
 * Deterministic provider for tests and offline demos.
 * Protocol: a user message of the form `:tool <name> <json>` triggers a tool
 * call; anything else is echoed back word by word.
 */
export function mockProvider(profile: ProviderProfile): Provider {
  return {
    profile,
    async *chat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const last = [...req.messages].reverse().find((m) => m.role === 'user' || m.role === 'tool');
      if (last?.role === 'tool') {
        const summary = (last.toolResults ?? [])
          .map((r) => `${r.name} → ${r.content.slice(0, 120)}`)
          .join('; ');
        for (const word of `Tool finished: ${summary}`.split(' ')) {
          yield { type: 'text', delta: word + ' ' };
        }
        yield { type: 'stop', reason: 'end' };
        return;
      }
      const text = last?.content ?? '';
      const toolMatch = text.match(/^:tool\s+(\S+)\s*(\{.*\})?\s*$/s);
      if (toolMatch) {
        yield {
          type: 'tool-call',
          call: {
            id: `mock_${Date.now()}`,
            name: toolMatch[1] ?? '',
            arguments: toolMatch[2] ? JSON.parse(toolMatch[2]) : {},
          },
        };
        yield { type: 'stop', reason: 'tool-use' };
        return;
      }
      for (const word of `You said: ${text}`.split(' ')) {
        yield { type: 'text', delta: word + ' ' };
      }
      yield { type: 'stop', reason: 'end' };
    },
  };
}
