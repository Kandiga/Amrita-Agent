import type { LaneMandate, MergeReport, Usage } from '@amrita/protocol';
import { type BudgetReason, evaluateBudget } from './budget.ts';
import { scrubEnv } from './env.ts';
import { createNodeProcessRunner, isWithinRoots } from './process-runner.ts';
import {
  type LaneRunContext,
  type LaneRunner,
  LaneSafetyError,
  type ProcessResult,
  type ProcessRunner,
  buildReport,
  emptyUsage,
} from './runner.ts';
import { parseStreamJsonLine } from './stream-json.ts';

/**
 * The Claude Code lane runner. Safety-first (ADR-0014 / ADR-0015):
 *
 * - **No real execution by default.** `run()` throws `LaneSafetyError` unless a
 *   `ProcessRunner` is injected (the test/controlled path) or
 *   `allowRealExecution` is explicitly set (which uses the real `claude` binary
 *   via `createNodeProcessRunner`). CI always injects a fake runner.
 * - **Workspace confinement.** When `allowedRoots` is configured the mandate's
 *   path must resolve inside one of them, or the lane is refused.
 * - **No shell, no secrets.** Args go to `spawn(file, args)` (no shell); the
 *   child env is deny-by-default scrubbed — `ANTHROPIC_API_KEY` and friends are
 *   never forwarded (Claude Code uses its own subscription login).
 * - **Budget/cancel.** Time and turn budgets terminate the child and report
 *   `exit: 'budget'`; an operator cancel reports `exit: 'cancelled'`.
 *
 * Real runs use `--output-format stream-json` and a narrow `--allowedTools` set;
 * output is parsed tolerantly into progress events and a final usage/summary.
 */
export interface ClaudeCodeLaneRunnerOptions {
  processRunner?: ProcessRunner;
  allowRealExecution?: boolean;
  envAllowlist?: string[];
  baseEnv?: Record<string, string | undefined>;
  command?: string;
  clock?: () => number;
  /** Absolute workspace roots the mandate path must resolve within. */
  allowedRoots?: string[];
  /** `text` parses one JSON blob (foundation/fake); `stream-json` parses NDJSON. */
  outputFormat?: 'text' | 'stream-json';
  /** The narrow tool set passed to `--allowedTools` (default read-only). */
  allowedTools?: string[];
  /** Max assistant turns when the mandate omits a turn budget. */
  defaultMaxTurns?: number;
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

/** Text-mode (`--print`) stdout: a single JSON `{ usage?, summary? }` blob. */
function parseTextOutput(stdout: string): ParsedOutput {
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
  private readonly allowedRoots: string[];
  private readonly outputFormat: 'text' | 'stream-json';
  private readonly allowedTools: string[];
  private readonly defaultMaxTurns: number;

  constructor(opts: ClaudeCodeLaneRunnerOptions = {}) {
    this.processRunner = opts.processRunner;
    this.allowRealExecution = opts.allowRealExecution ?? false;
    this.envAllowlist = opts.envAllowlist ?? [];
    this.baseEnv = opts.baseEnv ?? process.env;
    this.command = opts.command ?? 'claude';
    this.clock = opts.clock ?? Date.now;
    this.allowedRoots = opts.allowedRoots ?? [];
    this.outputFormat = opts.outputFormat ?? (this.allowRealExecution ? 'stream-json' : 'text');
    this.allowedTools = opts.allowedTools ?? ['Read', 'Grep', 'Glob', 'LS'];
    this.defaultMaxTurns = opts.defaultMaxTurns ?? 12;
  }

  private resolveRunner(): ProcessRunner {
    if (this.processRunner) return this.processRunner;
    if (this.allowRealExecution)
      return createNodeProcessRunner({ allowedRoots: this.allowedRoots });
    throw new LaneSafetyError(
      'real Claude Code execution is disabled: inject a processRunner or set allowRealExecution',
    );
  }

  private maxTurnsFor(mandate: LaneMandate): number {
    return mandate.budget.maxTurns ?? this.defaultMaxTurns;
  }

  /** The CLI invocation. No shell — args are passed to `spawn(file, args)`. */
  private buildArgs(mandate: LaneMandate, maxTurns: number): string[] {
    const args = ['--print', mandate.goal];
    if (this.outputFormat === 'stream-json') {
      args.push('--output-format', 'stream-json', '--verbose', '--max-turns', String(maxTurns));
      if (this.allowedTools.length > 0) args.push('--allowedTools', this.allowedTools.join(','));
    }
    return args;
  }

  async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
    const runner = this.resolveRunner(); // throws (safely) if real exec is not enabled

    // Workspace confinement: the mandate path must resolve within an allowed root.
    const cwd = mandate.scope.paths?.[0];
    if (this.allowedRoots.length > 0) {
      if (!cwd) {
        return buildReport(mandate, 'aborted', 'workspace confinement: mandate has no path');
      }
      if (!isWithinRoots(cwd, this.allowedRoots)) {
        return buildReport(
          mandate,
          'aborted',
          'workspace confinement: path is outside allowed roots',
        );
      }
    }

    const env = scrubEnv(this.baseEnv, this.envAllowlist);
    const maxTurns = this.maxTurnsFor(mandate);
    const args = this.buildArgs(mandate, maxTurns);
    ctx?.onProgress?.('preparing claude-code lane', 0);

    // An internal controller lets us abort the child on a turn-budget overrun,
    // composed with the caller's cancel signal.
    const internal = new AbortController();
    let budgetReason: BudgetReason | null = null;
    const signal = ctx?.signal ? AbortSignal.any([ctx.signal, internal.signal]) : internal.signal;

    let buffer = '';
    let turns = 0;
    let streamUsage: Usage | undefined;
    let streamSummary: string | undefined;
    const handleLine = (line: string): void => {
      const ev = parseStreamJsonLine(line);
      if (!ev) return;
      if (ev.note) ctx?.onProgress?.(ev.note);
      if (ev.turn) {
        turns += 1;
        if (turns > maxTurns && !budgetReason) {
          budgetReason = 'maxTurns';
          internal.abort();
        }
      }
      if (ev.isResult) {
        if (ev.usage) streamUsage = ev.usage;
        if (ev.summary) streamSummary = ev.summary;
      }
    };
    const onStdout =
      this.outputFormat === 'stream-json'
        ? (chunk: string): void => {
            buffer += chunk;
            let nl = buffer.indexOf('\n');
            while (nl >= 0) {
              handleLine(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf('\n');
            }
          }
        : (chunk: string): void => {
            const note = chunk.trim();
            if (note) ctx?.onProgress?.(note.slice(0, 200));
          };

    const timeoutMs =
      mandate.budget.maxMinutes !== undefined ? mandate.budget.maxMinutes * 60_000 : undefined;
    const startedAt = this.clock();
    let result: ProcessResult;
    try {
      result = await runner.run({
        command: this.command,
        args,
        env,
        ...(cwd ? { cwd } : {}),
        signal,
        onStdout,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    } catch (e) {
      if (ctx?.signal?.aborted) return buildReport(mandate, 'cancelled', 'cancelled by operator');
      const reason = e instanceof Error ? e.message : String(e);
      return buildReport(mandate, 'aborted', `runner error: ${reason}`);
    }
    if (this.outputFormat === 'stream-json' && buffer.trim()) handleLine(buffer);

    const elapsedMs = this.clock() - startedAt;
    const parsed: ParsedOutput =
      this.outputFormat === 'stream-json'
        ? {
            usage: streamUsage ?? emptyUsage(),
            ...(streamSummary ? { summary: streamSummary } : {}),
          }
        : parseTextOutput(result.stdout);
    const { usage } = parsed;

    // Classification, in priority order.
    if (ctx?.signal?.aborted)
      return buildReport(mandate, 'cancelled', 'cancelled by operator', { usage });
    if (budgetReason)
      return buildReport(mandate, 'budget', `budget exceeded (${budgetReason})`, { usage });
    if (result.timedOut) {
      return buildReport(mandate, 'budget', 'budget exceeded (maxMinutes: timed out)', { usage });
    }
    const overrun = evaluateBudget(mandate.budget, {
      turns,
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
    return buildReport(mandate, 'done', parsed.summary ?? `completed: ${mandate.goal}`, { usage });
  }
}
