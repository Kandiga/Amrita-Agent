import { spawn } from 'node:child_process';
import type { LaneMandate, MergeReport, Usage } from '@amrita/protocol';
import { evaluateBudget } from './budget.ts';
import { scrubEnv } from './env.ts';
import {
  type LaneRunContext,
  type LaneRunner,
  LaneSafetyError,
  type ProcessResult,
  type ProcessRunner,
  buildReport,
  emptyUsage,
} from './runner.ts';

/**
 * The Claude Code lane runner — the first concrete `LaneRunner`. It is built for
 * safety first (ADR-0014):
 *
 * - **No real execution by default.** `run()` throws `LaneSafetyError` unless a
 *   `ProcessRunner` is injected (the test/controlled path) or
 *   `allowRealExecution` is explicitly set (which uses a real child process).
 *   CI always injects a fake runner and never sets the flag.
 * - **Scrubbed env.** The child gets a deny-by-default environment; the daemon's
 *   secrets — including `ANTHROPIC_API_KEY` — are never forwarded (Claude Code
 *   authenticates via its own subscription login).
 * - **Budget guard.** Reported usage and elapsed time are checked against the
 *   mandate budget; an overrun returns `exit: 'budget'`.
 */
export interface ClaudeCodeLaneRunnerOptions {
  /** Injected child-process boundary. When present, the real binary is not used. */
  processRunner?: ProcessRunner;
  /** Explicit opt-in to spawn the real `claude` binary (ignored if a runner is injected). */
  allowRealExecution?: boolean;
  /** Extra env-var NAMES to forward (still filtered against the forbidden list). */
  envAllowlist?: string[];
  /** Base environment to scrub (defaults to `process.env`). */
  baseEnv?: Record<string, string | undefined>;
  /** The CLI command to invoke (default `claude`). */
  command?: string;
  /** Injectable clock for the time budget (default `Date.now`). */
  clock?: () => number;
}

interface ParsedOutput {
  usage: Usage;
  summary?: string;
}

function normalizeUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0;
  const output = typeof u.outputTokens === 'number' ? u.outputTokens : 0;
  const usd = typeof u.usd === 'number' ? u.usd : undefined;
  return { inputTokens: input, outputTokens: output, ...(usd !== undefined ? { usd } : {}) };
}

/** Best-effort parse of a runner's stdout: a JSON `{ usage?, summary? }` blob. */
function parseProcessOutput(stdout: string): ParsedOutput {
  const trimmed = stdout.trim();
  if (!trimmed) return { usage: emptyUsage() };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      usage: normalizeUsage(obj.usage),
      ...(typeof obj.summary === 'string' ? { summary: obj.summary } : {}),
    };
  } catch {
    return { usage: emptyUsage() };
  }
}

export class ClaudeCodeLaneRunner implements LaneRunner {
  readonly kind = 'claude-code';
  private readonly processRunner: ProcessRunner | undefined;
  private readonly allowRealExecution: boolean;
  private readonly envAllowlist: string[];
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly command: string;
  private readonly clock: () => number;

  constructor(opts: ClaudeCodeLaneRunnerOptions = {}) {
    this.processRunner = opts.processRunner;
    this.allowRealExecution = opts.allowRealExecution ?? false;
    this.envAllowlist = opts.envAllowlist ?? [];
    this.baseEnv = opts.baseEnv ?? process.env;
    this.command = opts.command ?? 'claude';
    this.clock = opts.clock ?? Date.now;
  }

  private resolveRunner(): ProcessRunner {
    if (this.processRunner) return this.processRunner;
    if (this.allowRealExecution) return createNodeProcessRunner();
    throw new LaneSafetyError(
      'real Claude Code execution is disabled: inject a processRunner or set allowRealExecution',
    );
  }

  /** The CLI invocation for a mandate. Kept minimal for the foundation. */
  private buildArgs(mandate: LaneMandate): string[] {
    return ['--print', mandate.goal];
  }

  async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
    const runner = this.resolveRunner(); // throws (safely) if real exec is not enabled
    const env = scrubEnv(this.baseEnv, this.envAllowlist);
    ctx?.onProgress?.('preparing claude-code lane', 0);

    const startedAt = this.clock();
    let result: ProcessResult;
    try {
      result = await runner.run({
        command: this.command,
        args: this.buildArgs(mandate),
        env,
        ...(mandate.scope.paths?.[0] ? { cwd: mandate.scope.paths[0] } : {}),
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
        onStdout: (chunk) => {
          const note = chunk.trim();
          if (note) ctx?.onProgress?.(note.slice(0, 200));
        },
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return buildReport(mandate, 'aborted', `runner error: ${reason}`);
    }

    if (ctx?.signal?.aborted) return buildReport(mandate, 'aborted', 'aborted by caller');

    const elapsedMs = this.clock() - startedAt;
    const { usage, summary } = parseProcessOutput(result.stdout);

    const overrun = evaluateBudget(mandate.budget, {
      tokens: usage.inputTokens + usage.outputTokens,
      ...(usage.usd !== undefined ? { usd: usage.usd } : {}),
      elapsedMs,
    });
    if (overrun) return buildReport(mandate, 'budget', `budget exceeded (${overrun})`, { usage });

    if (result.exitCode !== 0) {
      return buildReport(mandate, 'partial', `claude exited with code ${result.exitCode}`, {
        usage,
      });
    }

    ctx?.onProgress?.('lane complete', 100);
    return buildReport(mandate, 'done', summary ?? `completed: ${mandate.goal}`, { usage });
  }
}

/**
 * A real child-process runner over `node:child_process`. **Dormant by default**
 * — only reached when `allowRealExecution` is set, never in tests/CI. Kept small
 * and dependency-free; the environment it receives is already scrubbed.
 */
export function createNodeProcessRunner(): ProcessRunner {
  return {
    run(opts) {
      return new Promise<ProcessResult>((resolve, reject) => {
        const child = spawn(opts.command, opts.args, {
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          env: opts.env, // already scrubbed by the caller
          ...(opts.signal ? { signal: opts.signal } : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => {
          const s = d.toString('utf8');
          stdout += s;
          opts.onStdout?.(s);
        });
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString('utf8');
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
      });
    },
  };
}
