import type { AmritaEvent } from '@amrita/protocol';
import {
  type WatchAction,
  type WatchState,
  decideSweep,
  decideWatch,
  emptyWatchState,
} from './watch-decide.ts';

/**
 * The Watcher SHELL (ADR-0048 §8.3) — a thin event-driven adapter around the pure
 * `watch-decide` core, mirroring `http.ts`'s `store.subscribe` fan-out. It owns:
 * the subscription, the in-memory `WatchState`, one wall-clock sweep timer for the
 * stall/approval rules, and the dispatch of each action to the ONE output the plan
 * allows — an Inbox proposal. It NEVER appends a new event type and never calls
 * back into the store's write path from inside the subscribe callback beyond that
 * proposal. `store.subscribe` already swallows listener errors so a Watcher fault
 * can never break `appendEvent`; we still guard so a bad dispatch cannot wedge it.
 */
export interface OrchestrationWatcherOptions {
  subscribe: (listener: (ev: AmritaEvent) => void) => () => void;
  /** The single side effect: raise an Inbox proposal (origin 'lane'). */
  propose: (action: WatchAction) => void;
  /** Injected clock (ISO). Tests pass a deterministic one. */
  now?: () => string;
  /** Sweep cadence for stall/approval; 0 disables the timer (tests drive sweep). */
  sweepIntervalMs?: number;
  /** Injected timer for tests; defaults to global setInterval. */
  setIntervalImpl?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalImpl?: (handle: ReturnType<typeof setInterval>) => void;
}

export class OrchestrationWatcher {
  private readonly state: WatchState = emptyWatchState();
  private readonly opts: OrchestrationWatcherOptions;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(opts: OrchestrationWatcherOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.unsubscribe) return; // idempotent
    this.unsubscribe = this.opts.subscribe((ev) => this.onEvent(ev));
    const interval = this.opts.sweepIntervalMs ?? 60_000;
    if (interval > 0) {
      const set = this.opts.setIntervalImpl ?? setInterval;
      this.timer = set(() => this.sweep(), interval);
      // Never keep the process alive just to nag.
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Run the time-based rules once. Public so a test (or a host scheduler) drives it. */
  sweep(now: string = (this.opts.now ?? isoNow)()): void {
    if (this.stopped) return;
    this.dispatch(decideSweep(this.state, now));
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer) {
      (this.opts.clearIntervalImpl ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  private onEvent(ev: AmritaEvent): void {
    if (this.stopped) return;
    try {
      this.dispatch(decideWatch(this.state, ev));
    } catch {
      // A malformed event must never wedge the write-path fan-out.
    }
  }

  private dispatch(actions: WatchAction[]): void {
    for (const action of actions) {
      try {
        this.opts.propose(action);
      } catch {
        // One failed proposal must not drop the rest, nor break the subscription.
      }
    }
  }
}

const isoNow = (): string => new Date().toISOString();
