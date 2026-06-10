import type { LaneMandate, MergeReport, Usage } from '@amrita/protocol';
import { type BudgetSpend, evaluateBudget } from './budget.ts';
import {
  type LaneExit,
  type LaneRunContext,
  type LaneRunner,
  buildReport,
  emptyUsage,
} from './runner.ts';

/**
 * A deterministic in-process lane runner for tests and dry-run/demo flows. It
 * executes no process and touches no environment, so it is always safe in CI.
 * A `script` shapes its behaviour: progress notes, the final exit/summary, and
 * an optional simulated `spend` that is checked against the mandate budget (so a
 * `budget` abort is exercised without real work).
 */
export interface FakeLaneScript {
  progress?: { note: string; pct?: number }[];
  summary?: string;
  exit?: LaneExit;
  usage?: Usage;
  decisions?: string[];
  tasks?: string[];
  followUps?: string[];
  /** Throw from `run()` (to exercise the orchestrator's abort path). */
  throwError?: string;
  /** Simulated spend; if it exceeds the mandate budget, `run()` returns `budget`. */
  spend?: BudgetSpend;
}

export class FakeLaneRunner implements LaneRunner {
  readonly kind = 'fake';
  private readonly script: FakeLaneScript;

  constructor(script: FakeLaneScript = {}) {
    this.script = script;
  }

  async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
    if (this.script.throwError) throw new Error(this.script.throwError);

    for (const p of this.script.progress ?? []) {
      if (ctx?.signal?.aborted) break;
      ctx?.onProgress?.(p.note, p.pct);
    }
    if (ctx?.signal?.aborted) return buildReport(mandate, 'aborted', 'aborted by caller');

    const usage = this.script.usage ?? emptyUsage();
    if (this.script.spend) {
      const overrun = evaluateBudget(mandate.budget, this.script.spend);
      if (overrun) return buildReport(mandate, 'budget', `budget exceeded (${overrun})`, { usage });
    }

    return buildReport(
      mandate,
      this.script.exit ?? 'done',
      this.script.summary ?? 'fake lane complete',
      {
        usage,
        ...(this.script.decisions ? { decisions: this.script.decisions } : {}),
        ...(this.script.tasks ? { tasks: this.script.tasks } : {}),
        ...(this.script.followUps ? { followUps: this.script.followUps } : {}),
      },
    );
  }
}
