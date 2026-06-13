/**
 * The chat-provider boundary. A `ChatProvider` turns a transcript into one
 * assistant reply, **asynchronously**. The deterministic `mock` provider needs
 * no config; the real adapters (`anthropic`, `openai`) are constructed with a
 * secret value read from the environment *at construction time only* — that value
 * goes into the request's auth header and is never stored, logged, or returned.
 *
 * Provider calls are pure side effects — the kernel `await`s `generate()` OUTSIDE
 * any store transaction, then persists the result as events. Adapters accept an
 * injectable `fetchImpl` (and the CLI adapter an injectable `execImpl`), so
 * tests never hit the network and never spawn processes.
 */
import { spawnSync } from 'node:child_process';

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

// ── role policy (D5) ─────────────────────────────────────────────────────────

/** The provider roles a turn can ask for instead of a concrete provider. */
export const PROVIDER_ROLES = ['fast', 'main', 'deep'] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/** Settings key for a role binding: `providers.role.<role>` → RoleBinding. */
export const ROLE_SETTING_PREFIX = 'providers.role.';

/**
 * Settings key for a role binding at a given scope. Scopes resolve
 * project > global > auto (docs/strategy/native-interactive-surface.md §2.8);
 * lane/task and session scopes are additive keys on the same resolver later.
 */
export function roleSettingKey(role: ProviderRole, projectId?: string): string {
  return projectId
    ? `project.${projectId}.${ROLE_SETTING_PREFIX}${role}`
    : `${ROLE_SETTING_PREFIX}${role}`;
}

/** A role's configured target. Stored in `settings` (non-secret by definition). */
export interface RoleBinding {
  provider: string;
  model?: string;
}

/** Narrow an unknown settings value to a RoleBinding, or undefined. */
export function parseRoleBinding(value: unknown): RoleBinding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.provider !== 'string' || obj.provider.length === 0) return undefined;
  return {
    provider: obj.provider,
    ...(typeof obj.model === 'string' && obj.model.length > 0 ? { model: obj.model } : {}),
  };
}

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
  // body is absent for GETs (a GET with a body is a fetch() TypeError)
  init: { method: string; headers: Record<string, string>; body?: string },
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

/**
 * OpenAI-compatible chat-completions adapter. `baseUrl` must INCLUDE the
 * version segment (e.g. `https://api.openai.com/v1`,
 * `https://openrouter.ai/api/v1`, `http://localhost:11434/v1`,
 * `https://generativelanguage.googleapis.com/v1beta/openai`) — the adapter
 * appends only `/chat/completions`, which is what makes OpenRouter, Gemini's
 * compat surface, and local servers (Ollama/vLLM/LM Studio) all real targets.
 */
export function createOpenaiProvider(opts: AdapterOptions & { id?: string }): ChatProvider {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const id = opts.id ?? 'openai';
  return {
    id,
    async generate(req: ChatRequest): Promise<ChatResponse> {
      const messages = req.messages.map((m) => ({
        role: m.role === 'agent' ? 'assistant' : m.role,
        content: m.text,
      }));
      const body = JSON.stringify({ model: req.model, messages });
      let res: FetchResponseLike;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
          body,
        });
      } catch {
        throw new ProviderError('provider_error', `${id} request failed (network error)`);
      }
      if (!res.ok) {
        throw new ProviderError('provider_error', `${id} request failed with status ${res.status}`);
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

// ── claude-code subscription adapter (cli_session) ──────────────────────────

/** Bounded synchronous CLI execution — injectable so tests never spawn. */
export type CliExec = (
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
) => { status: number | null; stdout: string; stderr: string };

export const defaultCliExec: CliExec = (cmd, args, input, timeoutMs) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: timeoutMs });
  if (r.error) return { status: null, stdout: '', stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

const CLAUDE_CLI_TIMEOUT_MS = 180_000;

/** Flatten a transcript into one prompt for the single-shot `claude -p` call. */
export function flattenTranscript(messages: ChatMessage[]): string {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.text);
  const turns = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role === 'agent' ? 'Assistant' : 'User'}: ${m.text}`);
  return [...system, ...turns, 'Assistant:'].join('\n\n');
}

interface ClaudeCliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Chat through the locally logged-in Claude Code CLI (`claude -p
 * --output-format json`) — the user's SUBSCRIPTION session. No API key exists
 * anywhere in this path; Amrita never reads or forwards credentials, it only
 * invokes the CLI the user already logged into. Output shape verified against
 * Claude Code 2.x. Errors are classified, never echoed (CLI output can
 * mention account identifiers).
 */
export function createClaudeCliProvider(opts: { execImpl?: CliExec }): ChatProvider {
  const exec = opts.execImpl ?? defaultCliExec;
  return {
    id: 'claude-code',
    async generate(req: ChatRequest): Promise<ChatResponse> {
      const args = ['-p', '--output-format', 'json', '--model', req.model];
      const r = exec('claude', args, flattenTranscript(req.messages), CLAUDE_CLI_TIMEOUT_MS);
      if (r.status === null) {
        throw new ProviderError(
          'provider_unavailable',
          'the `claude` CLI was not found or timed out — install with `npm install -g @anthropic-ai/claude-code`',
        );
      }
      let parsed: ClaudeCliResult | null = null;
      try {
        parsed = JSON.parse(r.stdout) as ClaudeCliResult;
      } catch {
        parsed = null;
      }
      if (r.status !== 0 || !parsed || parsed.is_error === true || parsed.subtype !== 'success') {
        const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
        const hint =
          combined.includes('login') || combined.includes('auth') || combined.includes('api key')
            ? 'the claude CLI is not logged in — run `claude` once and log in, then retry'
            : 'the claude CLI returned an error (run `claude` interactively to inspect)';
        throw new ProviderError('provider_error', `claude-code turn failed: ${hint}`);
      }
      return {
        text: parsed.result ?? '',
        finishReason: parsed.stop_reason ?? 'stop',
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

// ── provider catalog ─────────────────────────────────────────────────────────

/** How a catalog provider authenticates (mirrors the protocol's authMode enum). */
export type ProviderAuthMode = 'api_key' | 'subscription_cli' | 'local_endpoint' | 'oauth';
export type ProviderGroup = 'login' | 'api_key' | 'local';

/**
 * The real provider catalog (ADR-0025). UI surfaces render FROM this metadata —
 * adding a provider here is the whole job; no bespoke wizard/web code per
 * provider. `executable: false` marks catalog entries Amrita can DETECT but
 * not yet run chat through — they render as honestly unavailable, never
 * silently disappear and never pretend.
 */
export interface RealProviderSpec {
  id: string;
  title: string;
  group: ProviderGroup;
  authMode: ProviderAuthMode;
  defaultModel: string;
  /** Whether the adapter implements `generateStream` (live `model.delta`). */
  streaming: boolean;
  /** Default env-var NAME for api_key providers (user may override at bind time). */
  envName?: string;
  /** Where a human gets a key (api_key providers). */
  keyUrl?: string;
  /** OpenAI-compatible base URL INCLUDING version segment, where fixed. */
  baseUrl?: string;
  /** CLI to detect for login providers + how to install it. */
  detectCli?: string;
  installHint?: string;
  /** False → detection-only: never offered as a runnable brain. */
  executable: boolean;
  create?(opts: AdapterOptions & { id?: string; execImpl?: CliExec }): ChatProvider;
}

export const REAL_PROVIDERS: readonly RealProviderSpec[] = [
  // streaming: false until real SSE adapters land — reported honestly, never faked.
  {
    id: 'claude-code',
    title: 'Claude subscription (via Claude Code login)',
    group: 'login',
    authMode: 'subscription_cli',
    defaultModel: 'sonnet',
    streaming: false,
    detectCli: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    executable: true,
    create: (opts) => createClaudeCliProvider(opts),
  },
  {
    id: 'codex',
    title: 'OpenAI account (via Codex CLI login)',
    group: 'login',
    authMode: 'oauth',
    defaultModel: 'gpt-5-codex',
    streaming: false,
    detectCli: 'codex',
    installHint: 'npm install -g @openai/codex',
    // Honesty: Amrita can DETECT the codex CLI but does not run chat through
    // it yet — the entry renders as unavailable with this exact explanation.
    executable: false,
  },
  {
    id: 'anthropic',
    title: 'Anthropic API key (Claude)',
    group: 'api_key',
    authMode: 'api_key',
    defaultModel: 'claude-sonnet-4-5',
    streaming: false,
    envName: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    executable: true,
    create: createAnthropicProvider,
  },
  {
    id: 'openai',
    title: 'OpenAI API key',
    group: 'api_key',
    authMode: 'api_key',
    defaultModel: 'gpt-4o-mini',
    streaming: false,
    envName: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    executable: true,
    create: createOpenaiProvider,
  },
  {
    id: 'openrouter',
    title: 'OpenRouter (one key, hundreds of models)',
    group: 'api_key',
    authMode: 'api_key',
    defaultModel: 'openrouter/auto',
    streaming: false,
    envName: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/settings/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    executable: true,
    create: (opts) => createOpenaiProvider({ ...opts, id: 'openrouter' }),
  },
  {
    id: 'gemini',
    title: 'Google Gemini API key',
    group: 'api_key',
    authMode: 'api_key',
    defaultModel: 'gemini-2.5-flash',
    streaming: false,
    envName: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    // Google's OpenAI-compatible surface — a real, documented endpoint.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    executable: true,
    create: (opts) => createOpenaiProvider({ ...opts, id: 'gemini' }),
  },
  {
    id: 'local',
    title: 'Local / self-hosted (Ollama, vLLM, LM Studio — OpenAI-compatible)',
    group: 'local',
    authMode: 'local_endpoint',
    defaultModel: '', // comes from the configured endpoint
    streaming: false,
    executable: true,
    create: (opts) => createOpenaiProvider({ ...opts, id: 'local' }),
  },
];

// ── local endpoint config (settings-backed, non-secret) ─────────────────────

/** Settings key holding the local OpenAI-compatible endpoint config. */
export const LOCAL_ENDPOINT_SETTING = 'providers.endpoint.local';

/** Non-secret endpoint config: URL + model (+ optional key env NAME). */
export interface LocalEndpointConfig {
  baseUrl: string;
  model: string;
  keyEnv?: string;
}

/** Narrow an unknown settings value to a LocalEndpointConfig, or undefined. */
export function parseLocalEndpoint(value: unknown): LocalEndpointConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.baseUrl !== 'string' || obj.baseUrl.length === 0) return undefined;
  if (typeof obj.model !== 'string' || obj.model.length === 0) return undefined;
  return {
    baseUrl: obj.baseUrl,
    model: obj.model,
    ...(typeof obj.keyEnv === 'string' && obj.keyEnv.length > 0 ? { keyEnv: obj.keyEnv } : {}),
  };
}

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
  /** Whether replies stream live as `model.delta` (ADR-0016); never faked. */
  streaming: boolean;
  /** Catalog metadata (absent for mock) — ADR-0025. */
  title?: string;
  group?: ProviderGroup;
  authMode?: ProviderAuthMode;
  executable?: boolean;
}

/** One chooser-UI entry from `providers.catalog` (ADR-0025). Value-free. */
export interface ProviderCatalogEntry {
  id: string;
  title: string;
  group: ProviderGroup;
  authMode: ProviderAuthMode;
  defaultModel: string;
  executable: boolean;
  envName?: string;
  keyUrl?: string;
  installHint?: string;
  /**
   * `ready` only after real evidence (env presence / live CLI probe / endpoint
   * config). `unavailable` = detected but not runnable, with the reason in
   * `detail` — honesty over cosmetics.
   */
  state: 'ready' | 'needs_key' | 'needs_login' | 'missing_cli' | 'needs_endpoint' | 'unavailable';
  detail: string;
  fix?: string;
}
