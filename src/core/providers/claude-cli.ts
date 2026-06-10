import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  ChatRequest,
  Provider,
  ProviderProfile,
  ProviderStreamEvent,
} from '../../shared/types.ts';

/**
 * Claude Code as a local-login provider for Amrita's brain.
 *
 * This drives the officially-documented headless mode of the installed
 * `claude` CLI (`claude -p --output-format stream-json`) under whatever login
 * the user already has — a Pro/Max subscription or the Agent SDK credit.
 * Amrita never reads or stores Claude's credentials; the CLI owns auth.
 *
 * Scope, stated honestly: this is a *conversational* brain. Claude Code runs
 * its own agent internally, so we disable its tools and do NOT bridge Amrita's
 * native tool-calling protocol through it — it answers in text. For tool-using
 * / coding work, use the Claude Code *connector* (`claude_code_run`) instead.
 */

/** The binary to invoke. Overridable for tests via AMRITA_CLAUDE_BIN. */
export function claudeBin(): string {
  return process.env.AMRITA_CLAUDE_BIN || 'claude';
}

export interface ClaudeAuthStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  error?: string;
}

/**
 * Probe `claude auth status --json` — a read-only status command that returns
 * `{ loggedIn, authMethod, subscriptionType, ... }` and NO token. Amrita reads
 * only the login state; it stores nothing.
 */
export function claudeAuthStatus(): ClaudeAuthStatus {
  const r = spawnSync(claudeBin(), ['auth', 'status', '--json'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { installed: false, loggedIn: false, error: 'claude CLI not found on PATH' };
    }
    return { installed: true, loggedIn: false, error: r.error.message };
  }
  try {
    const data = JSON.parse(r.stdout || '{}') as {
      loggedIn?: boolean;
      authMethod?: string;
      subscriptionType?: string;
    };
    return {
      installed: true,
      loggedIn: Boolean(data.loggedIn),
      authMethod: data.authMethod,
      subscriptionType: data.subscriptionType,
    };
  } catch {
    return { installed: true, loggedIn: false, error: 'could not read auth status' };
  }
}

// Disable Claude Code's own tools so this provider only ever responds in text.
const DENY_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'TodoWrite',
];

/**
 * Hand the CLI only a basic shell environment. Crucially we do NOT forward
 * ANTHROPIC_API_KEY — that would route through API credits instead of the
 * subscription login — nor any of Amrita's other secrets.
 */
function childEnv(): NodeJS.ProcessEnv {
  const ALLOW = new Set([
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR',
    'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'SystemRoot',
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ALLOW.has(k) || k.startsWith('CLAUDE_')) out[k] = v;
  }
  return out;
}

function flatten(req: ChatRequest): string {
  const lines: string[] = [];
  for (const m of req.messages) {
    if (m.role === 'user') lines.push(`User: ${m.content}`);
    else if (m.role === 'assistant' && m.content) lines.push(`Assistant: ${m.content}`);
    // tool messages are intentionally omitted — tools are not bridged here.
  }
  return lines.join('\n\n');
}

/** Turn raw CLI failure text into a plain-language, actionable message. */
export function friendlyClaudeError(raw: string): string {
  const t = (raw || '').toLowerCase();
  if (t.includes('credit') || t.includes('usage limit') || t.includes('exhaust') || t.includes('quota')) {
    return 'Claude Code usage/credit appears exhausted for now — switch to an API key (amrita setup) or wait for it to reset.';
  }
  if (t.includes('not logged in') || t.includes('unauthor') || t.includes('login')) {
    return 'Claude Code is not logged in. Run: claude auth login';
  }
  return (raw || '').trim().slice(0, 300) || 'Claude Code returned no output.';
}

interface StreamLine {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: { content?: { type?: string; text?: string }[] };
}

export function claudeCliProvider(profile: ProviderProfile): Provider {
  return {
    profile,
    async *chat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const args = ['-p', flatten(req) || ' ', '--output-format', 'stream-json', '--verbose'];
      if (req.model && req.model !== 'default') args.push('--model', String(req.model));
      if (req.system) args.push('--append-system-prompt', req.system);
      args.push('--disallowedTools', ...DENY_TOOLS);

      const child = spawn(claudeBin(), args, {
        cwd: tmpdir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(),
      });

      // Bridge the event-emitting child into an async generator.
      const queue: ProviderStreamEvent[] = [];
      let done = false;
      let notify: (() => void) | null = null;
      const wake = () => {
        notify?.();
        notify = null;
      };
      const push = (e: ProviderStreamEvent) => {
        queue.push(e);
        wake();
      };

      let buffer = '';
      let stderr = '';
      let sawText = false;
      let sawError = false;

      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let ev: StreamLine;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'assistant') {
            for (const block of ev.message?.content ?? []) {
              if (block.type === 'text' && typeof block.text === 'string') {
                sawText = true;
                push({ type: 'text', delta: block.text });
              }
            }
          } else if (ev.type === 'result' && ev.is_error) {
            sawError = true;
            push({ type: 'error', message: friendlyClaudeError(ev.result ?? stderr) });
          }
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });

      const onAbort = () => child.kill('SIGTERM');
      req.signal.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err: NodeJS.ErrnoException) => {
        const msg =
          err.code === 'ENOENT'
            ? 'Claude Code CLI not found. Install it (claude.ai/code) or run `amrita setup` and pick an API provider.'
            : `Claude Code failed to start: ${err.message}`;
        push({ type: 'error', message: msg });
        push({ type: 'stop', reason: 'end' });
        done = true;
        wake();
      });
      child.on('close', (code) => {
        if (code !== 0 && !sawText && !sawError) {
          push({ type: 'error', message: friendlyClaudeError(stderr) });
        }
        push({ type: 'stop', reason: 'end' });
        done = true;
        wake();
      });

      try {
        while (true) {
          while (queue.length) yield queue.shift()!;
          if (done) break;
          await new Promise<void>((r) => {
            notify = r;
          });
        }
      } finally {
        req.signal.removeEventListener('abort', onAbort);
        if (!child.killed) child.kill('SIGTERM');
      }
    },
  };
}
