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

/**
 * The Codex CLI lane runner (`codex exec --json`) — the ChatGPT-subscription
 * twin of the Claude Code runner, with the same safety posture (ADR-0014/0015):
 *
 * - **No real execution by default**: `run()` throws `LaneSafetyError` unless a
 *   `ProcessRunner` is injected (tests) or `allowRealExecution` is set.
 * - **Workspace confinement**: the mandate path must resolve inside an allowed
 *   root; the child runs `--sandbox workspace-write` confined to that cwd.
 * - **No shell, no secrets**: `spawn(file, args)`; deny-by-default env scrub —
 *   Codex authenticates via its own `codex login` session (HOME), never a
 *   forwarded API key.
 * - **Budget/cancel**: turn budget aborts the child; maxMinutes uses the
 *   process timeout; cancel reports `cancelled`.
 *
 * Event shapes verified live against codex-cli 0.144.1: `thread.started`,
 * `turn.started`, `item.completed{item.type: agent_message|command_execution|
 * file_change|reasoning|error}`, `turn.completed{usage}`, `turn.failed{error}`.
 */
export interface CodexLaneRunnerOptions {
  processRunner?: ProcessRunner;
  allowRealExecution?: boolean;
  envAllowlist?: string[];
  baseEnv?: Record<string, string | undefined>;
  command?: string;
  clock?: () => number;
  /** Absolute workspace roots the mandate path must resolve within. */
  allowedRoots?: string[];
  /** Max turns when the mandate omits a turn budget. */
  defaultMaxTurns?: number;
}

interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  message?: string;
  exit_code?: number;
}
interface CodexEvent {
  type?: string;
  item?: CodexItem;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class CodexLaneRunner implements LaneRunner {
  readonly kind = 'codex';
  private readonly processRunner: ProcessRunner | undefined;
  private readonly allowRealExecution: boolean;
  private readonly envAllowlist: string[];
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly command: string;
  private readonly clock: () => number;
  private readonly allowedRoots: string[];
  private readonly defaultMaxTurns: number;

  constructor(opts: CodexLaneRunnerOptions = {}) {
    this.processRunner = opts.processRunner;
    this.allowRealExecution = opts.allowRealExecution ?? false;
    this.envAllowlist = opts.envAllowlist ?? [];
    this.baseEnv = opts.baseEnv ?? process.env;
    this.command = opts.command ?? 'codex';
    this.clock = opts.clock ?? Date.now;
    this.allowedRoots = opts.allowedRoots ?? [];
    this.defaultMaxTurns = opts.defaultMaxTurns ?? 12;
  }

  private resolveRunner(): ProcessRunner {
    if (this.processRunner) return this.processRunner;
    if (this.allowRealExecution)
      return createNodeProcessRunner({ allowedRoots: this.allowedRoots });
    throw new LaneSafetyError(
      'real Codex execution is disabled: inject a processRunner or set allowRealExecution',
    );
  }

  async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
    const runner = this.resolveRunner();

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
    const maxTurns = mandate.budget.maxTurns ?? this.defaultMaxTurns;
    // No shell: the goal is one positional argv entry. The sandbox confines
    // writes to the cwd; --skip-git-repo-check because workspaces are fresh dirs.
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'workspace-write',
      mandate.goal,
    ];
    ctx?.onProgress?.('preparing codex lane', 0);

    const internal = new AbortController();
    let budgetReason: BudgetReason | null = null;
    const signal = ctx?.signal ? AbortSignal.any([ctx.signal, internal.signal]) : internal.signal;

    let buffer = '';
    let turns = 0;
    let usage: Usage | undefined;
    let summary: string | undefined;
    let failure: string | undefined;
    const handleLine = (line: string): void => {
      if (!line.trim()) return;
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
      } catch {
        return; // tolerant: non-JSON noise is never fatal
      }
      switch (ev.type) {
        case 'turn.started':
          turns += 1;
          if (turns > maxTurns && !budgetReason) {
            budgetReason = 'maxTurns';
            internal.abort();
          }
          break;
        case 'item.completed': {
          const item = ev.item ?? {};
          if (item.type === 'agent_message' && item.text) {
            summary = item.text;
            ctx?.onProgress?.(item.text.slice(0, 200));
          } else if (item.type === 'command_execution' && item.command) {
            ctx?.onProgress?.(`$ ${item.command.slice(0, 180)}`);
          } else if (item.type === 'file_change') {
            ctx?.onProgress?.('writing files in the workspace');
          } else if (item.type === 'error' && item.message) {
            ctx?.onProgress?.(`codex: ${item.message.slice(0, 180)}`);
          }
          break;
        }
        case 'turn.completed':
          if (ev.usage) {
            usage = {
              inputTokens: ev.usage.input_tokens ?? 0,
              outputTokens: ev.usage.output_tokens ?? 0,
            };
          }
          break;
        case 'turn.failed':
        case 'error':
          failure = ev.error?.message ?? 'codex turn failed';
          break;
        default:
          break;
      }
    };
    const onStdout = (chunk: string): void => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
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
    if (buffer.trim()) handleLine(buffer);

    const elapsedMs = this.clock() - startedAt;
    const finalUsage = usage ?? emptyUsage();

    if (ctx?.signal?.aborted)
      return buildReport(mandate, 'cancelled', 'cancelled by operator', { usage: finalUsage });
    if (budgetReason)
      return buildReport(mandate, 'budget', `budget exceeded (${budgetReason})`, {
        usage: finalUsage,
      });
    if (result.timedOut) {
      return buildReport(mandate, 'budget', 'budget exceeded (maxMinutes: timed out)', {
        usage: finalUsage,
      });
    }
    const overrun = evaluateBudget(mandate.budget, {
      turns,
      tokens: finalUsage.inputTokens + finalUsage.outputTokens,
      ...(finalUsage.usd !== undefined ? { usd: finalUsage.usd } : {}),
      elapsedMs,
    });
    if (overrun)
      return buildReport(mandate, 'budget', `budget exceeded (${overrun})`, { usage: finalUsage });
    if (failure) {
      // never echo raw provider errors (they can carry account details)
      return buildReport(mandate, 'partial', 'codex reported an error (see lane progress)', {
        usage: finalUsage,
      });
    }
    if (result.exitCode !== 0) {
      return buildReport(mandate, 'partial', `codex exited with code ${result.exitCode}`, {
        usage: finalUsage,
      });
    }

    ctx?.onProgress?.('lane complete', 100);
    return buildReport(mandate, 'done', summary ?? `completed: ${mandate.goal}`, {
      usage: finalUsage,
    });
  }
}
