import { resolve as resolvePath } from 'node:path';
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
  /** Pause after typing the agent name, to let its process start. Tunable for tests. */
  launchDelayMs?: number;
  /** Minimum delay before typing the goal, to let the agent UI initialize. */
  goalDelayMs?: number;
}

/**
 * What the CURRENT screen (pane tail) shows while the agent CLI boots. A fresh
 * `claude` in a brand-new directory does NOT go straight to the REPL — it first
 * shows a folder-trust dialog (and, on a first-ever run, a theme picker). Typing
 * the goal on a blind timer would land it INSIDE that dialog (verified in review),
 * so goal delivery is gated on this classification:
 * - `prompt`  — a narrowly allowlisted accept-the-default dialog (folder trust /
 *   theme). The jailed workspace is a brand-new empty dir the daemon itself created,
 *   so accepting is safe by construction: press Enter, then wait for the screen to move on.
 * - `login`   — the CLI wants a human login. Never keypress into it.
 * - `blocked` — another interactive choice (for example an updater). Never keypress.
 * - `ready`   — an explicit Claude/Codex input prompt; only this state may receive the goal.
 * - `none`    — blank, spinner, or unknown startup output. Wait; never guess readiness.
 * Trailing blank rows from full-screen TUIs are stripped before inspecting the last
 * ~30 lines; otherwise a trust/login dialog near the top of a cleared screen can be
 * pushed out of the classifier window by empty rows.
 */
export function classifyBootPane(pane: string): 'prompt' | 'login' | 'blocked' | 'ready' | 'none' {
  const tail = pane.trimEnd().split('\n').slice(-30).join('\n');
  // Authentication/account selection has precedence over every default-accept
  // pattern. A mixed or partially redrawn TUI must always fail closed.
  if (
    /select (?:a )?(?:login|sign-in|account) method|sign in(?: to continue| with)|log ?in with|paste (?:the )?(?:auth )?code here|please log ?in|use an api key|chatgpt account|continue (?:in|with) (?:browser|chatgpt)|authenticate/i.test(
      tail,
    )
  ) {
    return 'login';
  }
  if (
    /trust the files in this (folder|directory)|do you trust|is this a project you created or one you trust|yes,? i trust this folder/i.test(
      tail,
    )
  ) {
    return 'prompt';
  }
  if (/choose the text style|choose your theme/i.test(tail)) return 'prompt';
  if (
    /update available|update now|installing update/i.test(tail) ||
    (/(?:^|\n)\s*[❯›>]\s*\d+[.)]/m.test(tail) && /press enter|enter to confirm/i.test(tail))
  ) {
    return 'blocked';
  }
  if (
    /(?:^|\n)\s*[❯›]\u00a0?(?:\s*$|\s+(?!\d+[.)]))/m.test(tail) ||
    /(?:^|\n)\s*│\s*>\s*(?:\n|$)/m.test(tail)
  ) {
    return 'ready';
  }
  return 'none';
}

/** Durable progress marker used to decide whether a restarted session still needs its goal. */
export const SESSION_GOAL_SENT_PROGRESS = 'sent the goal to the session';

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
  const marker = '‹redacted›';
  return text
    .replace(
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
      `[PRIVATE KEY ${marker}]`,
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, `sk-${marker}`)
    .replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/g, marker)
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, marker)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, marker)
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, marker)
    .replace(/\b(Authorization)(\s*:\s*)(?:Basic|Bearer)\s+\S+/gi, `$1$2${marker}`)
    .replace(/([?&](?:access_token|api[_-]?key|token|secret|password)=)[^&\s]+/gi, `$1${marker}`)
    .replace(
      /((?:["']?)(?:(?:[A-Z][A-Z0-9_]*_)?(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?KEY|DATABASE[_-]?URL|REDIS[_-]?URL|MONGODB[_-]?URI|CONNECTION[_-]?STRING))(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi,
      `$1${marker}`,
    )
    .replace(
      /\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY|DATABASE_URL|REDIS_URL|MONGODB_URI|CONNECTION_STRING))(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi,
      `$1$2${marker}`,
    )
    .replace(/\b(API[_-]?KEY|TOKEN|SECRET|PASSWORD|BEARER)([\s=:]+)\S+/gi, `$1$2${marker}`);
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
    const ensureSessionGone = async (): Promise<void> => {
      let cleanupAttempts = 0;
      while (await tmux.hasSession(name)) {
        cleanupAttempts += 1;
        try {
          await tmux.killSession(name);
        } catch {
          // Verification below is authoritative; never terminalize while tmux survives.
        }
        if (await tmux.hasSession(name)) {
          if (cleanupAttempts === 3 || cleanupAttempts % 20 === 0) {
            ctx?.onProgress?.('session cleanup is retrying; tmux remains under control', 99);
          }
          await sleep(Math.min(1000, 50 * cleanupAttempts));
        }
      }
    };

    let state = await tmux.sessionState(name);
    const resuming = state.exists;
    if (!resuming) {
      // Fixed argv only. The tmux boundary prefixes `exec`, so launch failure or
      // agent exit leaves a dead pane — never a shell that could execute the goal.
      const command =
        this.cfg.agent === 'codex'
          ? ['codex', '-c', 'check_for_update_on_startup=false']
          : ['claude'];
      await tmux.newSession({ name, cwd, agent: this.cfg.agent, command });
      ctx?.onProgress?.(`opened a ${this.cfg.agent} session`, 5);
      state = await tmux.sessionState(name);
    } else {
      ctx?.onProgress?.('re-attached to the running session', 5);
    }
    if (
      state.dead ||
      state.agent !== this.cfg.agent ||
      state.cwd === null ||
      resolvePath(state.cwd) !== resolvePath(cwd)
    ) {
      const summary = state.dead
        ? `${this.cfg.agent} session exited before it became ready`
        : state.agent !== this.cfg.agent
          ? `refused: tmux session identity mismatch (expected ${this.cfg.agent})`
          : 'refused: tmux session escaped its mandated workspace';
      await ensureSessionGone();
      return buildReport(mandate, 'aborted', summary);
    }

    const start = clock();
    let goalSent = state.goalSent || (ctx?.sessionGoalAlreadySent ?? false);
    // A daemon may crash after tmux accepted its atomic goal queue but before the
    // audit event persisted. Repair that evidence from tmux, the delivery SSOT.
    if (state.goalSent && !ctx?.sessionGoalAlreadySent) {
      ctx?.onProgress?.(SESSION_GOAL_SENT_PROGRESS, 15);
    }
    let last = '';
    let ended: LaneExit | null = null;
    // Boot-dialog handling: at most a few default-accepts, one per distinct screen.
    let bootAnswersLeft = 3;
    let lastAnsweredPane = '';
    let awaitingAuthNotified = false;
    let blockedPromptNotified = false;

    while (ended === null) {
      state = await tmux.sessionState(name);
      if (
        !state.exists ||
        state.dead ||
        state.agent !== this.cfg.agent ||
        state.cwd === null ||
        resolvePath(state.cwd) !== resolvePath(cwd)
      ) {
        ended = 'partial';
        break;
      }
      const pane = redactPane(await tmux.capturePane(name));
      if (pane !== last) {
        last = pane;
        ctx?.onPane?.(pane);
      }

      if (!goalSent) {
        // Classify the VISIBLE SCREEN (`lines: 0`), never the scrollback tail: a
        // non-clearing TUI (Codex) keeps its ANSWERED trust dialog in history, and
        // a scrollback-fed classifier re-detects it forever and never reaches
        // `ready` (found live, 2026-07-16). The streamed pane keeps scrollback.
        const visible = redactPane(await tmux.capturePane(name, 0));
        const boot = classifyBootPane(visible);
        const waited = clock() - start;
        if (boot === 'prompt' && bootAnswersLeft > 0 && visible !== lastAnsweredPane) {
          // Accept the dialog's highlighted default (Enter only, never text).
          await tmux.sendKeys(name, '', { enter: true });
          bootAnswersLeft -= 1;
          lastAnsweredPane = visible;
          ctx?.onProgress?.('accepted the agent boot dialog', 10);
        } else if (boot === 'login') {
          // Authentication is always human-owned. A timeout must never turn the
          // user's goal into input for a login/account-selection screen.
          if (!awaitingAuthNotified) {
            awaitingAuthNotified = true;
            ctx?.onProgress?.('awaiting operator authentication; no session input was sent', 10);
          }
        } else if (boot === 'blocked') {
          if (!blockedPromptNotified) {
            blockedPromptNotified = true;
            ctx?.onProgress?.(
              'agent startup needs an operator choice; no session input was sent',
              10,
            );
          }
        } else if (boot === 'ready' && waited >= goalDelay) {
          const sentNow = await tmux.sendGoalOnce(name, mandate.goal);
          goalSent = true;
          // `false` means a previous daemon already submitted the atomic queue; if
          // its durable audit is absent, repair it rather than resending the goal.
          if (sentNow || !ctx?.sessionGoalAlreadySent) {
            ctx?.onProgress?.(SESSION_GOAL_SENT_PROGRESS, 15);
          }
        }
      }

      if (ctx?.signal?.aborted) ended = 'cancelled';
      else if (ctx?.finishSignal?.aborted) ended = 'done';
      else if (clock() - start > maxMs) ended = 'budget';
      else await sleep(interval, ctx?.signal);
    }

    const finalPane = redactPane(await tmux.capturePane(name).catch(() => last));
    if (finalPane && finalPane !== last) ctx?.onPane?.(finalPane);

    await ensureSessionGone();

    return buildReport(mandate, ended, summarize(finalPane || last, this.cfg.agent, ended));
  }
}
