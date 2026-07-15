import type { LaneExit, LaneMandate, MergeReport } from '@amrita/protocol';
import { isWithinRoots } from './process-runner.ts';
import { type LaneRunContext, type LaneRunner, buildReport, goalLooksLikeFlag } from './runner.ts';
import type { TmuxController } from './tmux.ts';

/**
 * An INTERACTIVE, observable execution session (ADR-0049). Unlike the headless
 * one-shot runner, this launches the agent CLI (claude/codex) inside a tmux pane,
 * streams the pane to the operator (`onPane` → stream-only `lane.pane`), and lets
 * them watch, send input, and finish it. The tmux session OUTLIVES the daemon, so a
 * restart RE-ATTACHES instead of orphan-aborting.
 *
 * Honest limits (ADR-0049): pane text is a noisy TUI snapshot, not an event log, so
 * machine truth comes from the workspace files, not the screen; only wall-clock/idle
 * budget is enforced (token/usd are not observable here); the read-only allowlist is
 * dropped, so this is safe only ATTENDED (the Approval Constitution gates it).
 */
export interface TmuxSessionRunnerConfig {
  agent: 'claude' | 'codex';
  tmux: TmuxController;
  allowedRoots: readonly string[];
  defaultMaxMinutes?: number;
  /** Injectable clock for tests (ms). */
  clock?: () => number;
  captureIntervalMs?: number;
  /** Delay before typing the goal, to let the agent UI initialize. */
  goalDelayMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** Best-effort redaction of secret-shaped content before it leaves the pane. */
export function redactPane(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-‹redacted›')
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, 'ghp_‹redacted›')
    .replace(/\b(API[_-]?KEY|TOKEN|SECRET|PASSWORD|BEARER)([\s=:]+)\S+/gi, '$1$2‹redacted›');
}

function summarize(pane: string, agent: string, exit: LaneExit): string {
  const lines = pane
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-8).join('\n');
  return `${agent} session ${exit}. Last output:\n${tail}`.slice(0, 2000);
}

export class TmuxSessionLaneRunner implements LaneRunner {
  readonly kind: string;
  // An explicit field, NOT a constructor parameter property — the daemon runs `.ts`
  // via Node's strip-only mode, which does not support parameter properties.
  private readonly cfg: TmuxSessionRunnerConfig;

  constructor(cfg: TmuxSessionRunnerConfig) {
    this.cfg = cfg;
    this.kind = cfg.agent === 'claude' ? 'claude-code-tmux' : 'codex-tmux';
  }

  async run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport> {
    const { tmux } = this.cfg;

    if (goalLooksLikeFlag(mandate.goal)) {
      return buildReport(mandate, 'aborted', 'refused: the goal looks like a command-line flag');
    }
    const cwd = mandate.scope.paths?.[0];
    if (!cwd) {
      return buildReport(mandate, 'aborted', 'refused: an interactive session needs a workspace');
    }
    if (!isWithinRoots(cwd, this.cfg.allowedRoots)) {
      return buildReport(mandate, 'aborted', `refused: ${cwd} is outside every allowed root`);
    }
    if (!(await tmux.available())) {
      return buildReport(
        mandate,
        'aborted',
        'refused: tmux is not installed — install it (e.g. `apt-get install tmux`)',
      );
    }

    const name = `amrita-${mandate.laneId}`;
    const clock = this.cfg.clock ?? (() => Date.now());
    const interval = this.cfg.captureIntervalMs ?? 1000;
    const goalDelay = this.cfg.goalDelayMs ?? 2000;
    const maxMs = (mandate.budget.maxMinutes ?? this.cfg.defaultMaxMinutes ?? 30) * 60_000;

    const resuming = await tmux.hasSession(name);
    if (!resuming) {
      await tmux.newSession({ name, cwd, command: [] }); // bare shell
      ctx?.onProgress?.(`opened a ${this.cfg.agent} session`, 5);
      await sleep(400, ctx?.signal);
      await tmux.sendKeys(name, this.cfg.agent, { enter: true }); // launch the agent (fixed argv)
    } else {
      ctx?.onProgress?.('re-attached to the running session', 5);
    }

    const start = clock();
    let goalSent = resuming; // never re-send the goal on a resume
    let last = '';
    let ended: LaneExit | null = null;

    while (ended === null) {
      if (!goalSent && clock() - start >= goalDelay) {
        await tmux.sendKeys(name, mandate.goal, { enter: true }); // literal — no shell
        goalSent = true;
        ctx?.onProgress?.('sent the goal to the session', 15);
      }

      const pane = redactPane(await tmux.capturePane(name));
      if (pane !== last) {
        last = pane;
        ctx?.onPane?.(pane);
      }

      if (ctx?.signal?.aborted) ended = 'cancelled';
      else if (ctx?.finishSignal?.aborted) ended = 'done';
      else if (clock() - start > maxMs) ended = 'budget';
      else if (!(await tmux.hasSession(name))) ended = 'partial';
      else await sleep(interval, ctx?.signal);
    }

    const finalPane = redactPane(await tmux.capturePane(name).catch(() => last));
    if (finalPane && finalPane !== last) ctx?.onPane?.(finalPane);
    await tmux.killSession(name).catch(() => {});

    return buildReport(mandate, ended, summarize(finalPane || last, this.cfg.agent, ended));
  }
}
