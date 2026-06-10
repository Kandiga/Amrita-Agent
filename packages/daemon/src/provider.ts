/**
 * The chat-provider boundary. A `ChatProvider` turns a transcript into one
 * assistant reply. The only provider that actually runs in WO#2.3 is the
 * deterministic `mock` — real adapters (Anthropic, OpenAI, …) are *scaffolded*
 * for status/discovery but not executed, so tests never make a network call and
 * no secret value is ever read beyond a presence check.
 *
 * Provider calls are pure side effects — the kernel invokes `generate()` OUTSIDE
 * any store transaction, then persists the result as events.
 *
 * NOTE: `generate()` is synchronous here because the only implementation (mock)
 * is synchronous. Real HTTP adapters are async; integrating them is a future WO
 * that will make the kernel turn + RPC dispatch async (see ADR-0011).
 */

export interface ChatMessage {
  role: 'user' | 'agent' | 'system';
  text: string;
}
export interface ChatRequest {
  messages: ChatMessage[];
  model: string;
}
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}
export interface ChatResponse {
  text: string;
  finishReason: string;
  usage: ChatUsage;
}
export interface ChatProvider {
  readonly id: string;
  generate(req: ChatRequest): ChatResponse;
}

/** Structured provider failure (no stack/secret). `code` maps to an RPC error code. */
export class ProviderError extends Error {
  readonly code: 'provider_unavailable' | 'unknown_provider' | 'not_found';
  constructor(code: ProviderError['code'], message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export const MOCK_PROVIDER_ID = 'mock';

/** A deterministic provider for tests and local dev. No clock, no randomness. */
export class MockProvider implements ChatProvider {
  readonly id = MOCK_PROVIDER_ID;

  generate(req: ChatRequest): ChatResponse {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = lastUser
      ? `[mock:${req.model}] You said: "${lastUser.text}". (deterministic reply)`
      : `[mock:${req.model}] Hello from the mock provider.`;
    const inputTokens = req.messages.reduce((n, m) => n + Math.ceil(m.text.length / 4), 0);
    return {
      text,
      finishReason: 'stop',
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) },
    };
  }
}

/** Presence-only env check. Returns a boolean; never returns or logs the value. */
export function envPresent(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
}

export interface ProviderInfo {
  id: string;
  kind: 'mock' | 'scaffold';
  /** Whether `chat.turn` can run this provider right now. */
  available: boolean;
  /** The env var a real adapter would need (a NAME, never a value). */
  requiresEnv: string | null;
  /** Presence of that env var (boolean only). */
  envPresent: boolean;
}

interface ScaffoldEntry {
  id: string;
  requiresEnv: string;
}
const SCAFFOLD_PROVIDERS: readonly ScaffoldEntry[] = [
  { id: 'anthropic', requiresEnv: 'ANTHROPIC_API_KEY' },
  { id: 'openai', requiresEnv: 'OPENAI_API_KEY' },
];

/** Knows which providers exist and which can actually run. */
export class ProviderRegistry {
  private readonly mock = new MockProvider();

  list(): ProviderInfo[] {
    return [
      { id: MOCK_PROVIDER_ID, kind: 'mock', available: true, requiresEnv: null, envPresent: false },
      ...SCAFFOLD_PROVIDERS.map(
        (s): ProviderInfo => ({
          id: s.id,
          kind: 'scaffold',
          available: false, // not implemented in WO#2.3 — never runnable here
          requiresEnv: s.requiresEnv,
          envPresent: envPresent(s.requiresEnv),
        }),
      ),
    ];
  }

  /** Resolve a runnable provider, or throw a structured, secret-safe error. */
  resolveChat(id: string): ChatProvider {
    if (id === MOCK_PROVIDER_ID) return this.mock;
    const scaffold = SCAFFOLD_PROVIDERS.find((s) => s.id === id);
    if (scaffold) {
      throw new ProviderError(
        'provider_unavailable',
        `provider '${id}' is scaffolded but not implemented yet (would require the ${scaffold.requiresEnv} env var)`,
      );
    }
    throw new ProviderError('unknown_provider', `unknown provider: ${id}`);
  }
}
