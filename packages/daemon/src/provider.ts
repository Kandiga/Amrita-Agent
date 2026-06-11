/**
 * The chat-provider boundary. A `ChatProvider` turns a transcript into one
 * assistant reply, **asynchronously**. The deterministic `mock` provider needs
 * no config; the real adapters (`anthropic`, `openai`) are constructed with a
 * secret value read from the environment *at construction time only* — that value
 * goes into the request's auth header and is never stored, logged, or returned.
 *
 * Provider calls are pure side effects — the kernel `await`s `generate()` OUTSIDE
 * any store transaction, then persists the result as events. Adapters accept an
 * injectable `fetchImpl`, so tests never hit the network.
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
  generate(req: ChatRequest): Promise<ChatResponse>;
  /**
   * Optional streaming variant: emit incremental text via `onDelta`, then
   * resolve with the same final response `generate` would return. A provider
   * without it is driven through `generate` (no fake streaming is synthesized
   * for real adapters — honesty over cosmetics).
   */
  generateStream?(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse>;
}

/** Structured provider failure (no stack/secret/headers). `code` maps to an RPC code. */
export class ProviderError extends Error {
  readonly code:
    | 'provider_unavailable'
    | 'unknown_provider'
    | 'not_found'
    | 'missing_secret_ref'
    | 'missing_env_value'
    | 'provider_error';
  constructor(code: ProviderError['code'], message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export const MOCK_PROVIDER_ID = 'mock';

/** A deterministic provider for tests and local dev. No clock, no randomness, no I/O. */
export class MockProvider implements ChatProvider {
  readonly id = MOCK_PROVIDER_ID;

  async generate(req: ChatRequest): Promise<ChatResponse> {
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

  /** Stream the deterministic reply in word chunks; deltas concatenate to the final text. */
  async generateStream(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse> {
    const resp = await this.generate(req);
    for (const chunk of chunkText(resp.text)) {
      onDelta(chunk);
      await Promise.resolve(); // yield so listeners observe deltas before the final response
    }
    return resp;
  }
}

/** Split text into small word-group chunks whose concatenation is exactly the input. */
export function chunkText(text: string, wordsPerChunk = 3): string[] {
  const parts = text.split(/(?<=\s)/); // keep trailing whitespace with each word
  const chunks: string[] = [];
  for (let i = 0; i < parts.length; i += wordsPerChunk) {
    chunks.push(parts.slice(i, i + wordsPerChunk).join(''));
  }
  return chunks.filter((c) => c.length > 0);
}

// ── env secret boundary ──────────────────────────────────────────────────────

/** Presence-only env check. Returns a boolean; never returns or logs the value. */
export function envPresent(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0;
}

/**
 * Read a secret *value* from the environment. The ONLY place a secret value is
 * read — and only to hand it to an adapter's auth header in the same call. The
 * value is never returned to RPC/CLI, persisted, or logged.
 */
export function readEnvSecret(name: string): string | undefined {
  const v = process.env[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// ── fetch injection ──────────────────────────────────────────────────────────

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export const defaultFetch: FetchLike = (url, init) => {
  const f = globalThis.fetch;
  if (!f)
    throw new ProviderError('provider_unavailable', 'global fetch is unavailable in this runtime');
  return f(url, init) as Promise<FetchResponseLike>;
};

interface AdapterOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
  baseUrl?: string;
}

// ── anthropic ────────────────────────────────────────────────────────────────

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createAnthropicProvider(opts: AdapterOptions): ChatProvider {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = opts.baseUrl ?? 'https://api.anthropic.com';
  return {
    id: 'anthropic',
    async generate(req: ChatRequest): Promise<ChatResponse> {
      const system = req.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.text)
        .join('\n\n');
      const messages = req.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'agent' ? 'assistant' : 'user', content: m.text }));
      const body = JSON.stringify({
        model: req.model,
        max_tokens: 1024,
        ...(system ? { system } : {}),
        messages,
      });
      let res: FetchResponseLike;
      try {
        res = await fetchImpl(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body,
        });
      } catch {
        throw new ProviderError('provider_error', 'anthropic request failed (network error)');
      }
      if (!res.ok) {
        throw new ProviderError(
          'provider_error',
          `anthropic request failed with status ${res.status}`,
        );
      }
      const data = (await res.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      return {
        text,
        finishReason: data.stop_reason ?? 'stop',
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

// ── openai ───────────────────────────────────────────────────────────────────

interface OpenaiResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export function createOpenaiProvider(opts: AdapterOptions): ChatProvider {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = opts.baseUrl ?? 'https://api.openai.com';
  return {
    id: 'openai',
    async generate(req: ChatRequest): Promise<ChatResponse> {
      const messages = req.messages.map((m) => ({
        role: m.role === 'agent' ? 'assistant' : m.role,
        content: m.text,
      }));
      const body = JSON.stringify({ model: req.model, messages });
      let res: FetchResponseLike;
      try {
        res = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body,
        });
      } catch {
        throw new ProviderError('provider_error', 'openai request failed (network error)');
      }
      if (!res.ok) {
        throw new ProviderError(
          'provider_error',
          `openai request failed with status ${res.status}`,
        );
      }
      const data = (await res.json()) as OpenaiResponse;
      const choice = data.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        finishReason: choice?.finish_reason ?? 'stop',
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

/** The real (env-backed) provider catalog. */
export interface RealProviderSpec {
  id: string;
  defaultModel: string;
  create(opts: AdapterOptions): ChatProvider;
}
export const REAL_PROVIDERS: readonly RealProviderSpec[] = [
  { id: 'anthropic', defaultModel: 'claude-sonnet-4-5', create: createAnthropicProvider },
  { id: 'openai', defaultModel: 'gpt-4o-mini', create: createOpenaiProvider },
];

/** Provider availability, computed by the kernel from account config + env presence. */
export interface ProviderInfo {
  id: string;
  kind: 'mock' | 'real';
  /** Whether `chat.turn` can run this provider right now. */
  available: boolean;
  /** Number of bound accounts (with a secret_ref) for this provider. */
  configuredAccounts: number;
  /** Whether at least one bound account's env var is present (boolean only). */
  envReady: boolean;
}
