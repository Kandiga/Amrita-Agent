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
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { PROVIDER_ROLES } from '@amrita/protocol';
import type {
  AuthMode as ProviderAuthMode,
  ProviderCatalogEntryWire,
  ProviderGroup,
  ProviderInfoWire,
  ProviderRole,
  RoleBindingWire as RoleBinding,
} from '@amrita/protocol';

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

// The role list and binding shape are protocol-owned since ADR-0032;
// re-exported here so daemon-internal imports keep one obvious source.
export { PROVIDER_ROLES };
export type { ProviderRole, RoleBinding };

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

/**
 * SSRF guard for provider base URLs (security). A base URL can come from an
 * operator env var OR the auth-gated `providers.endpoint.local` setting, then
 * reaches `fetch()` with the user's key attached — so it is the one place an
 * authenticated caller could aim the daemon at an internal target. We refuse
 * exactly the two vectors with NO legitimate LLM use:
 *
 *   1. non-`http(s)` schemes (`file:`, `gopher:`, …);
 *   2. the cloud-metadata link-local range (`169.254.0.0/16`, `fe80::/10`,
 *      `fd00:ec2::254`) and the well-known metadata hostnames.
 *
 * Loopback / RFC-1918 stay ALLOWED on purpose: pointing at a local Ollama /
 * vLLM / LM Studio is the documented local-endpoint feature (its default is
 * `http://localhost:11434`), and the caller already holds a token that grants
 * strictly more power (real lane code execution). DNS rebinding is out of
 * scope for the same reason — this is a proportionate block on the specific
 * metadata-SSRF escalation, not a general egress firewall.
 */
export function assertSafeProviderUrl(rawUrl: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new ProviderError('provider_error', 'invalid provider base URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ProviderError('provider_error', 'provider base URL must be http(s)');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const BLOCKED_METADATA_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);
  if (
    BLOCKED_METADATA_HOSTS.has(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) || // IPv4 link-local (metadata)
    host.startsWith('fe80:') || // IPv6 link-local
    host === 'fd00:ec2::254' // AWS IMDS IPv6
  ) {
    throw new ProviderError(
      'provider_error',
      'provider base URL points at a link-local / cloud-metadata address (blocked)',
    );
  }
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
  assertSafeProviderUrl(baseUrl); // SSRF guard at the choke point (once, not per-turn)
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
  assertSafeProviderUrl(baseUrl); // SSRF guard at the choke point (once, not per-turn)
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

export interface CliExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process never produced a status — classified, never guessed. */
  failure?: 'not_found' | 'timeout' | 'spawn_error';
}

/**
 * Bounded CLI execution — injectable so tests never spawn. May return the
 * result synchronously (test fakes) or as a promise (the real async impl).
 */
export type CliExec = (
  cmd: string,
  args: string[],
  input: string,
  timeoutMs: number,
  /** Streaming taps: called once per complete stdout line (NDJSON). */
  onLine?: (line: string) => void,
) => CliExecResult | Promise<CliExecResult>;

/**
 * ASYNC by design: a chat turn can take minutes, and a synchronous spawn would
 * freeze the entire daemon (RPC, WS stream, scheduler, approvals) for its
 * whole duration — the exact "Amrita stopped responding" failure mode.
 */
/**
 * Every live CLI subprocess, so the daemon can reap them on shutdown (stability
 * audit: chat-turn/lane children were untracked and survived the daemon). Each
 * is a process-GROUP leader (detached), so killing -pid takes grandchildren too.
 */
const liveExecs = new Set<ReturnType<typeof spawn>>();

/** SIGKILL every tracked subprocess group. Called from kernel.close(). */
export function killAllCliExec(): void {
  for (const child of liveExecs) killGroup(child, 'SIGKILL');
  liveExecs.clear();
}

function killGroup(child: ReturnType<typeof spawn>, sig: NodeJS.Signals): void {
  try {
    // Negative pid = the whole process group (detached leader). Falls back to the
    // direct child if the group is already gone.
    if (child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    /* already exited */
  }
}

/** OOM backstop only — far larger than any real model reply, so never truncates one. */
const STDOUT_CAP_BYTES = 32 * 1024 * 1024;

export const defaultCliExec: CliExec = (cmd, args, input, timeoutMs, onLine) =>
  new Promise<CliExecResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // detached:true makes the child its own process-group leader so a timeout
      // or shutdown can kill the WHOLE tree, not just the direct child.
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
    } catch {
      resolve({ status: null, stdout: '', stderr: '', failure: 'spawn_error' });
      return;
    }
    liveExecs.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (r: CliExecResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const done = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      liveExecs.delete(child);
    };
    const timer = setTimeout(() => {
      // Escalate: SIGTERM the group, then SIGKILL if it will not die. The promise
      // settles now so the caller is never blocked on a wedged child.
      killGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
      settle({ status: null, stdout, stderr, failure: 'timeout' });
    }, timeoutMs);
    // StringDecoder keeps multibyte characters (Hebrew, emoji) intact when a code
    // point is split across two pipe reads — a plain toString('utf8') per chunk
    // corrupts them into replacement characters.
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let lineBuffer = '';
    child.stdout?.on('data', (c: Buffer) => {
      const chunk = outDec.write(c);
      if (stdout.length < STDOUT_CAP_BYTES) stdout += chunk;
      if (!onLine) return;
      lineBuffer += chunk;
      let nl = lineBuffer.indexOf('\n');
      while (nl >= 0) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        if (line.trim()) onLine(line);
        nl = lineBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (stderr.length < 16_384) stderr += errDec.write(c);
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      done();
      settle({
        status: null,
        stdout: '',
        stderr: '',
        failure: e.code === 'ENOENT' ? 'not_found' : 'spawn_error',
      });
    });
    child.on('close', (code) => {
      done();
      settle({ status: code, stdout, stderr });
    });
    child.stdin?.on('error', () => {
      // EPIPE from a dead child: the 'error'/'close' handlers own the outcome.
    });
    child.stdin?.end(input);
  });

/** Chat-turn budget; a long real turn beats a fast false timeout (env-tunable). */
const CLAUDE_CLI_TIMEOUT_MS =
  Number(process.env.AMRITA_CHAT_CLI_TIMEOUT_MS ?? '') > 0
    ? Number(process.env.AMRITA_CHAT_CLI_TIMEOUT_MS)
    : 300_000;

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
      // `--max-turns 1`: Amrita's chat brain REPLIES (and delegates), it does not run
      // the agentic tool loop and build things itself — that is what a lane/session is
      // for. Without it a "build me a game" chat turn spawns a full Claude Code build
      // that overruns the chat timeout (ADR-0048; "chat = structural, no tools").
      const args = ['-p', '--max-turns', '1', '--output-format', 'json', '--model', req.model];
      const r = await exec('claude', args, flattenTranscript(req.messages), CLAUDE_CLI_TIMEOUT_MS);
      if (r.status === null) {
        // Honest classification (never conflated): a timeout is not a missing CLI.
        if (r.failure === 'timeout') {
          throw new ProviderError(
            'provider_error',
            `claude-code turn timed out after ${Math.round(CLAUDE_CLI_TIMEOUT_MS / 1000)}s — long turns can exceed the budget; raise AMRITA_CHAT_CLI_TIMEOUT_MS or retry`,
          );
        }
        throw new ProviderError(
          'provider_unavailable',
          'the `claude` CLI was not found on the daemon PATH — install with `npm install -g @anthropic-ai/claude-code`',
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

    /**
     * Live streaming through the same CLI session: `--output-format
     * stream-json --include-partial-messages` (shapes verified against Claude
     * Code 2.1.207). Only assistant `text_delta`s are surfaced — thinking and
     * tool chatter stay backstage; the final `result` event is what persists.
     */
    async generateStream(req: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse> {
      const args = [
        '-p',
        // Reply in one turn; do not run the agentic build loop in a chat turn — a
        // lane/session does the building (ADR-0048). See the note in generate().
        '--max-turns',
        '1',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--model',
        req.model,
      ];
      let result: ClaudeCliResult | null = null;
      const seeLine = (line: string): void => {
        let ev: unknown;
        try {
          ev = JSON.parse(line);
        } catch {
          return; // hook noise / partial line — never fatal
        }
        const e = ev as {
          type?: string;
          event?: { type?: string; delta?: { type?: string; text?: string } };
        };
        if (e.type === 'stream_event' && e.event?.type === 'content_block_delta') {
          const delta = e.event.delta;
          if (delta?.type === 'text_delta' && delta.text) onDelta(delta.text);
        } else if (e.type === 'result') {
          result = ev as ClaudeCliResult;
        }
      };
      const r = await exec(
        'claude',
        args,
        flattenTranscript(req.messages),
        CLAUDE_CLI_TIMEOUT_MS,
        seeLine,
      );
      if (r.status === null) {
        if (r.failure === 'timeout') {
          throw new ProviderError(
            'provider_error',
            `claude-code turn timed out after ${Math.round(CLAUDE_CLI_TIMEOUT_MS / 1000)}s — long turns can exceed the budget; raise AMRITA_CHAT_CLI_TIMEOUT_MS or retry`,
          );
        }
        throw new ProviderError(
          'provider_unavailable',
          'the `claude` CLI was not found on the daemon PATH — install with `npm install -g @anthropic-ai/claude-code`',
        );
      }
      if (result === null) {
        // exec impls that buffer (test fakes) never call onLine — scan stdout.
        for (const line of r.stdout.split('\n')) seeLine(line);
      }
      // TS can't see assignments made inside the seeLine closure — re-widen.
      const parsed = result as ClaudeCliResult | null;
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

interface CodexExecEvent {
  type?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** Codex chat budget mirrors the claude one (long turns beat false timeouts). */
const CODEX_CLI_TIMEOUT_MS = CLAUDE_CLI_TIMEOUT_MS;

/**
 * Chat through the locally logged-in Codex CLI (`codex exec --json`) — the
 * user's ChatGPT SUBSCRIPTION session; no API key exists anywhere in this
 * path. The reply arrives whole (exec emits complete `agent_message` items,
 * not token deltas), so this adapter honestly declares `streaming: false`.
 * Chat runs read-only sandboxed — a chat turn must never write files. Event
 * shapes verified live against codex-cli 0.144.1. Model `default` = whatever
 * the login's plan serves (named ids are plan-dependent and refused otherwise).
 */
export function createCodexCliProvider(opts: { execImpl?: CliExec }): ChatProvider {
  const exec = opts.execImpl ?? defaultCliExec;
  return {
    id: 'codex-cli',
    async generate(req: ChatRequest): Promise<ChatResponse> {
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        ...(req.model && req.model !== 'default' ? ['-m', req.model] : []),
        '-', // prompt from stdin (the transcript can be long)
      ];
      let text = '';
      let usage = { inputTokens: 0, outputTokens: 0 };
      let failed = false;
      const seeLine = (line: string): void => {
        let ev: CodexExecEvent;
        try {
          ev = JSON.parse(line) as CodexExecEvent;
        } catch {
          return;
        }
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
          text = ev.item.text; // the last assistant message wins
        } else if (ev.type === 'turn.completed' && ev.usage) {
          usage = {
            inputTokens: ev.usage.input_tokens ?? 0,
            outputTokens: ev.usage.output_tokens ?? 0,
          };
        } else if (ev.type === 'turn.failed' || ev.type === 'error') {
          failed = true;
        }
      };
      const r = await exec(
        'codex',
        args,
        flattenTranscript(req.messages),
        CODEX_CLI_TIMEOUT_MS,
        seeLine,
      );
      if (r.status === null) {
        if (r.failure === 'timeout') {
          throw new ProviderError(
            'provider_error',
            `codex-cli turn timed out after ${Math.round(CODEX_CLI_TIMEOUT_MS / 1000)}s — raise AMRITA_CHAT_CLI_TIMEOUT_MS or retry`,
          );
        }
        throw new ProviderError(
          'provider_unavailable',
          'the `codex` CLI was not found on the daemon PATH — install with `npm install -g @openai/codex`',
        );
      }
      if (!text && !failed) for (const line of r.stdout.split('\n')) seeLine(line);
      if (r.status !== 0 || failed || !text) {
        const combined = `${r.stdout}\n${r.stderr}`.toLowerCase();
        const hint =
          combined.includes('login') || combined.includes('auth') || combined.includes('api key')
            ? 'the codex CLI is not logged in — run `codex login`, then retry'
            : 'the codex CLI returned an error (run `codex` interactively to inspect)';
        throw new ProviderError('provider_error', `codex-cli turn failed: ${hint}`);
      }
      return { text, finishReason: 'stop', usage };
    },
  };
}

// ── provider catalog ─────────────────────────────────────────────────────────

// Auth mode and group are protocol-owned enums since ADR-0032.
export type { ProviderAuthMode, ProviderGroup };

/**
 * Wire transport / API mode (Hermes `transport`→api_mode lesson, providers.py).
 * The kernel picks the adapter from this, not from the provider id, so a custom
 * endpoint can declare `openai_chat` or `anthropic_messages` explicitly instead
 * of being guessed. `cli_json` is the local-CLI subscription path.
 */
export type ProviderTransport = 'anthropic_messages' | 'openai_chat' | 'cli_json' | 'local_openai';

/**
 * Provider id aliases → canonical id (Hermes ALIASES lesson, providers.py:241+).
 * Human/legacy names normalize to one catalog id so `amrita model claude` and
 * `amrita role set main grok` resolve without bespoke handling.
 */
export const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  claude: 'anthropic',
  'claude-api': 'anthropic',
  anthropic_api: 'anthropic',
  'claude-subscription': 'claude-code',
  claudecode: 'claude-code',
  'claude-code-login': 'claude-code',
  gpt: 'openai',
  chatgpt: 'openai',
  'openai-api': 'openai',
  codex: 'codex-cli',
  'openai-codex': 'codex-cli',
  'chatgpt-subscription': 'codex-cli',
  router: 'openrouter',
  'open-router': 'openrouter',
  google: 'gemini',
  'google-gemini': 'gemini',
  ollama: 'local',
  vllm: 'local',
  lmstudio: 'local',
  'lm-studio': 'local',
  llamacpp: 'local',
  'local-endpoint': 'local',
};

/** Resolve a human/legacy provider name to its canonical catalog id. */
export function normalizeProvider(name: string): string {
  const key = name.trim().toLowerCase();
  return PROVIDER_ALIASES[key] ?? key;
}

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
  /** Wire transport / API mode this provider speaks (ADR-0026). */
  transport: ProviderTransport;
  defaultModel: string;
  /**
   * Curated fallback model ids shown in the picker when live discovery is
   * unavailable (Hermes models.py lesson: a curated list that live discovery
   * can supersede, never a hardcoded UI list). Most-capable first.
   */
  models?: readonly string[];
  /** Whether the adapter implements `generateStream` (live `model.delta`). */
  streaming: boolean;
  /** Default env-var NAME for api_key providers (user may override at bind time). */
  envName?: string;
  /** Env-var NAME that overrides `baseUrl` at runtime (Hermes base_url_env_var). */
  baseUrlEnvVar?: string;
  /** Where a human gets a key (api_key providers). */
  keyUrl?: string;
  /** OpenAI-compatible base URL INCLUDING version segment, where fixed. */
  baseUrl?: string;
  /** Whether `amrita model <id>` can live-discover models from `/models`. */
  supportsModelDiscovery?: boolean;
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
    transport: 'cli_json',
    defaultModel: 'sonnet',
    models: ['opus', 'sonnet', 'haiku'],
    streaming: true, // real: stream-json text deltas → model.delta (ADR verified on CLI 2.1.207)
    detectCli: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    executable: true,
    create: (opts) => createClaudeCliProvider(opts),
  },
  {
    id: 'codex-cli',
    title: 'ChatGPT subscription (via Codex login)',
    group: 'login',
    authMode: 'subscription_cli',
    transport: 'cli_json',
    // 'default' = the login's configured model (named ids are plan-dependent:
    // e.g. gpt-5.2-codex is refused on ChatGPT accounts — verified live).
    defaultModel: 'default',
    models: ['default'],
    streaming: false, // exec --json emits whole agent messages, never token deltas — honest
    detectCli: 'codex',
    installHint: 'npm install -g @openai/codex',
    executable: true,
    create: (opts) => createCodexCliProvider(opts),
  },
  {
    id: 'anthropic',
    title: 'Anthropic API key (Claude)',
    group: 'api_key',
    authMode: 'api_key',
    transport: 'anthropic_messages',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'],
    streaming: false,
    envName: 'ANTHROPIC_API_KEY',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    executable: true,
    create: createAnthropicProvider,
  },
  {
    id: 'openai',
    title: 'OpenAI API key',
    group: 'api_key',
    authMode: 'api_key',
    transport: 'openai_chat',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'],
    streaming: false,
    envName: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
    keyUrl: 'https://platform.openai.com/api-keys',
    supportsModelDiscovery: true,
    executable: true,
    create: createOpenaiProvider,
  },
  {
    id: 'openrouter',
    title: 'OpenRouter (one key, hundreds of models)',
    group: 'api_key',
    authMode: 'api_key',
    transport: 'openai_chat',
    defaultModel: 'openrouter/auto',
    models: [
      'openrouter/auto',
      'anthropic/claude-sonnet-4.5',
      'openai/gpt-4o',
      'google/gemini-2.5-flash',
    ],
    streaming: false,
    envName: 'OPENROUTER_API_KEY',
    baseUrlEnvVar: 'OPENROUTER_BASE_URL',
    keyUrl: 'https://openrouter.ai/settings/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    supportsModelDiscovery: true,
    executable: true,
    create: (opts) => createOpenaiProvider({ ...opts, id: 'openrouter' }),
  },
  {
    id: 'gemini',
    title: 'Google Gemini API key',
    group: 'api_key',
    authMode: 'api_key',
    transport: 'openai_chat',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
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
    transport: 'local_openai',
    defaultModel: '', // comes from the configured endpoint
    streaming: false,
    supportsModelDiscovery: true,
    executable: true,
    create: (opts) => createOpenaiProvider({ ...opts, id: 'local' }),
  },
];

/** Look up a catalog spec by id, resolving aliases first. */
export function findProviderSpec(idOrAlias: string): RealProviderSpec | undefined {
  const id = normalizeProvider(idOrAlias);
  return REAL_PROVIDERS.find((p) => p.id === id);
}

// ── live model discovery (Hermes /models probe lesson, main.py:3649+) ────────

/** Result of probing an OpenAI-compatible `/models` endpoint. Value-free. */
export interface ModelDiscovery {
  ok: boolean;
  models: string[];
  /** The URL actually probed (after any `/v1` normalization). */
  probedUrl: string;
  detail: string;
}

/**
 * If a base URL looks like a local server but is missing the `/v1` segment that
 * OpenAI-compatible servers (Ollama, vLLM, llama.cpp, LM Studio) require, return
 * the corrected URL — else undefined (Hermes local `/v1` hint, main.py:3623+).
 */
export function suggestV1BaseUrl(baseUrl: string): string | undefined {
  const u = baseUrl.trim().replace(/\/+$/, '');
  const looksLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|:11434|:8080|:5000|:1234/.test(u);
  if (looksLocal && !/\/v\d+$/.test(u)) return `${u}/v1`;
  return undefined;
}

interface OpenAiModelsResponse {
  data?: { id?: string }[];
}

/**
 * Probe an OpenAI-compatible `/models` endpoint for the live model list. Bounded,
 * never throws, never returns secrets. `baseUrl` must include the version segment.
 */
export async function probeOpenAiModels(opts: {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
}): Promise<ModelDiscovery> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  const probedUrl = `${opts.baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
  let res: FetchResponseLike;
  try {
    assertSafeProviderUrl(probedUrl); // SSRF guard — blocked URL → safe fallback below
    res = await fetchImpl(probedUrl, { method: 'GET', headers });
  } catch (e) {
    const detail = e instanceof ProviderError ? e.message : 'endpoint unreachable (network error)';
    return { ok: false, models: [], probedUrl, detail };
  }
  if (!res.ok) {
    return { ok: false, models: [], probedUrl, detail: `endpoint returned status ${res.status}` };
  }
  let body: OpenAiModelsResponse;
  try {
    body = (await res.json()) as OpenAiModelsResponse;
  } catch {
    return { ok: false, models: [], probedUrl, detail: 'endpoint returned non-JSON' };
  }
  const models = (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return {
    ok: true,
    models,
    probedUrl,
    detail: `${models.length} model(s) visible`,
  };
}

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

/**
 * Provider availability + chooser-catalog entry shapes are protocol-owned wire
 * contracts since ADR-0032 (`providerInfoSchema` / `providerCatalogEntrySchema`).
 * `ready` only ever follows real evidence — honesty over cosmetics (ADR-0025).
 */
export type ProviderInfo = ProviderInfoWire;
export type ProviderCatalogEntry = ProviderCatalogEntryWire;
