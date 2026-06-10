import type { LaneBudget, Usage } from '@amrita/protocol';

/**
 * Generic lane budget accounting. A lane may bound turns, tokens, dollar-ish
 * cost, and wall-clock minutes; when any bound is crossed the runner stops with
 * a `budget` exit. The accounting is deterministic and clock-injectable so the
 * abort path is unit-testable without real time passing.
 */

export type BudgetReason = 'maxTurns' | 'maxTokens' | 'maxUsd' | 'maxMinutes';

export interface BudgetSpend {
  turns?: number;
  tokens?: number;
  usd?: number;
  elapsedMs?: number;
}

/** The first bound `spend` exceeds, or `null` if it is within budget. */
export function evaluateBudget(budget: LaneBudget, spend: BudgetSpend): BudgetReason | null {
  if (budget.maxTurns !== undefined && (spend.turns ?? 0) > budget.maxTurns) return 'maxTurns';
  if (budget.maxTokens !== undefined && (spend.tokens ?? 0) > budget.maxTokens) return 'maxTokens';
  if (budget.maxUsd !== undefined && (spend.usd ?? 0) > budget.maxUsd) return 'maxUsd';
  if (budget.maxMinutes !== undefined && (spend.elapsedMs ?? 0) > budget.maxMinutes * 60_000) {
    return 'maxMinutes';
  }
  return null;
}

/** Stateful budget accumulation across turns, with an injectable clock. */
export class BudgetGuard {
  private readonly budget: LaneBudget;
  private readonly clock: () => number;
  private readonly startedAt: number;
  private turns = 0;
  private tokens = 0;
  private usd = 0;

  constructor(budget: LaneBudget, clock: () => number = Date.now) {
    this.budget = budget;
    this.clock = clock;
    this.startedAt = clock();
  }

  /** Account for one completed turn's usage. */
  recordTurn(usage?: Partial<Usage>): void {
    this.turns += 1;
    this.tokens += (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    this.usd += usage?.usd ?? 0;
  }

  /** The first bound currently exceeded (including elapsed time), or `null`. */
  exceeded(): BudgetReason | null {
    return evaluateBudget(this.budget, {
      turns: this.turns,
      tokens: this.tokens,
      usd: this.usd,
      elapsedMs: this.clock() - this.startedAt,
    });
  }
}
