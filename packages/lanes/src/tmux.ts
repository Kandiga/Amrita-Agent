import { type ChildProcess, spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { scrubEnv } from './env.ts';

/**
 * The tmux boundary (ADR-0049) — injected so unit tests never spawn tmux (a
 * `FakeTmuxController` scripts the pane), exactly like the `ProcessRunner` boundary.
 *
 * A DEDICATED socket (`-L amrita`) is used so the daemon's tmux server is separate
 * from any interactive shell's, and — because a server inherits the env of whoever
 * first starts it — the first spawn carries a SCRUBBED env, so the server (and every
 * session under it) never holds the daemon's secrets. Honest residual: if a prior,
 * unscrubbed server already owns that socket, sessions inherit its env (documented
 * in ADR-0049).
 */

const SOCKET = 'amrita';

export interface TmuxSessionSpec {
  name: string;
  cwd: string;
  agent: 'claude' | 'codex';
  /** Fixed executable + argv. The controller prefixes `exec`; no parent shell survives. */
  command: string[];
}

export interface TmuxSessionState {
  exists: boolean;
  dead: boolean;
  agent: string | null;
  goalSent: boolean;
  cwd: string | null;
}

export interface TmuxController {
  /** Is tmux installed and runnable? */
  available(): Promise<boolean>;
  hasSession(name: string): Promise<boolean>;
  sessionState(name: string): Promise<TmuxSessionState>;
  newSession(spec: TmuxSessionSpec): Promise<void>;
  /** Current pane content (a snapshot, not a delta). `lines` caps the tail. */
  capturePane(name: string, lines?: number): Promise<string>;
  /** Type literal text into the pane (no shell interpretation), optionally + Enter. */
  sendKeys(name: string, text: string, opts?: { enter?: boolean }): Promise<void>;
  /**
   * Atomically, in the surviving tmux server, set a per-session marker and paste the
   * goal at most once. Returns false when that marker was already present.
   */
  sendGoalOnce(name: string, text: string): Promise<boolean>;
  killSession(name: string): Promise<void>;
  listSessions(): Promise<string[]>;
}

interface TmuxRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runTmux(args: string[], timeoutMs = 10_000): Promise<TmuxRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn('tmux', ['-L', SOCKET, ...args], { env: scrubEnv() });
    } catch {
      resolve({ code: 127, stdout: '', stderr: 'spawn failed' });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr || 'spawn error' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The real tmux controller. Fixed argv, no persistent shell, dedicated socket, scrubbed env. */
export function createNodeTmuxController(): TmuxController {
  return {
    async available() {
      return (await runTmux(['-V'])).code === 0;
    },
    async hasSession(name) {
      return (await runTmux(['has-session', '-t', name])).code === 0;
    },
    async sessionState(name) {
      // PRINTABLE delimiter, never a control character: `display-message -p`
      // sanitizes control chars (a TAB becomes `_`) when the client has no locale
      // (`LANG`/`LC_*` unset) — exactly the daemon's systemd environment — which
      // corrupted a tab-delimited format into one field and made every session
      // look like an identity mismatch in production (found live, 2026-07-16).
      // The path is the LAST field and is re-joined, so even a path that contains
      // the delimiter reconstructs exactly; the fixed-vocabulary fields
      // (0/1, claude/codex, 0/1) never can.
      const D = ':::';
      const fmt = `#{pane_dead}${D}#{@amrita_agent}${D}#{@amrita_goal_sent}${D}#{pane_current_path}`;
      // A single `display-message` can lose a race when two control clients share
      // the server (the daemon's capture loop + a live browser terminal, ADR-0052)
      // and return non-zero — or a briefly-empty read before the option is visible
      // to this client. A spurious empty read would look like a WRONG-AGENT attach
      // and false-abort a healthy session (found live, 2026-07-16). So retry, and
      // only conclude "gone" when `has-session` ALSO reports it gone.
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await runTmux(['display-message', '-p', '-t', name, fmt]);
        if (r.code === 0) {
          const [dead = '', agent = '', goalSent = '', ...cwdParts] = r.stdout
            .replace(/\r?\n$/, '')
            .split(D);
          const cwd = cwdParts.join(D);
          // Trust the read only when identity fields actually came back; an empty
          // agent/cwd on a live session is a race artifact, not the truth.
          if (agent !== '' && cwd !== '') {
            return { exists: true, dead: dead === '1', agent, goalSent: goalSent === '1', cwd };
          }
        }
        if ((await runTmux(['has-session', '-t', name])).code !== 0) {
          return { exists: false, dead: true, agent: null, goalSent: false, cwd: null };
        }
        await new Promise((res) => setTimeout(res, 40 * (attempt + 1)));
      }
      // The session EXISTS (has-session kept succeeding) but its control read kept
      // racing. Report it alive with unknown identity; the caller must treat null
      // fields as "unconfirmed", never as a mismatch.
      return { exists: true, dead: false, agent: null, goalSent: false, cwd: null };
    },
    async newSession(spec) {
      if (spec.command.length === 0) throw new Error('tmux session command is required');
      if (!/^[A-Za-z0-9_-]+$/.test(spec.name)) throw new Error('invalid tmux session name');
      const cwdInfo = await stat(spec.cwd).catch(() => null);
      if (!cwdInfo?.isDirectory())
        throw new Error(`tmux session cwd is not a directory: ${spec.cwd}`);
      // tmux accepts a shell-command, so prefix the fixed argv with `exec`. The tiny
      // bootstrap shell is replaced by the agent; if exec fails it exits and the pane
      // becomes dead — there is never a reusable bare shell that can receive a goal.
      const r = await runTmux([
        'new-session',
        '-d',
        '-s',
        spec.name,
        '-c',
        spec.cwd,
        `exec ${spec.command.map(shellQuote).join(' ')}`,
        ';',
        'set-option',
        '-t',
        spec.name,
        'remain-on-exit',
        'on',
        ';',
        'set-option',
        '-t',
        spec.name,
        '@amrita_agent',
        spec.agent,
      ]);
      if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.code}`);
      const cwdResult = await runTmux([
        'display-message',
        '-p',
        '-t',
        spec.name,
        '#{pane_current_path}',
      ]);
      const actualCwd = cwdResult.stdout.trim();
      if (cwdResult.code !== 0 || resolvePath(actualCwd) !== resolvePath(spec.cwd)) {
        await runTmux(['kill-session', '-t', spec.name]);
        throw new Error(
          `tmux session cwd mismatch: expected ${spec.cwd}, got ${actualCwd || 'unavailable'}`,
        );
      }
    },
    async capturePane(name, lines = 200) {
      // -p print to stdout, -J join wrapped lines, -S -<lines> start N lines back.
      // `lines = 0` captures ONLY the visible screen (no -S): a TUI that does not
      // clear (Codex) leaves its ANSWERED trust dialog in scrollback, and any
      // classifier fed scrollback re-detects the dialog forever (found live,
      // 2026-07-16). Screen-state decisions must read the screen, not history.
      const r = await runTmux([
        'capture-pane',
        '-p',
        '-J',
        '-t',
        name,
        ...(lines > 0 ? ['-S', `-${lines}`] : []),
      ]);
      if (r.code !== 0) throw new Error(`tmux capture-pane failed: ${r.stderr.trim() || r.code}`);
      return r.stdout;
    },
    async sendKeys(name, text, opts) {
      // -l literal: the text is typed as-is, never interpreted as tmux key names or
      // a shell command. Enter is a separate, explicit key.
      let r = await runTmux(['send-keys', '-t', name, '-l', text]);
      if (r.code !== 0) throw new Error(`tmux send-keys failed: ${r.stderr.trim() || r.code}`);
      if (opts?.enter) {
        r = await runTmux(['send-keys', '-t', name, 'Enter']);
        if (r.code !== 0) throw new Error(`tmux send Enter failed: ${r.stderr.trim() || r.code}`);
      }
    },
    async sendGoalOnce(name, text) {
      if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid tmux session name');
      const buffer = `goal-${name}`;
      // One tmux client submits one command queue. `if-shell -F` is evaluated by the
      // tmux server after prior queues, so concurrent callers serialize on the marker.
      // Untrusted goal text is an argv to set-buffer, never embedded in a command string.
      //
      // `run-shell -d 0.5` is a SYNCHRONOUS server-side delay between the paste and
      // the Enter (verified on tmux 3.4). Without it the CR reaches the agent's stdin
      // in the same read burst as the bracketed-paste terminator and the Claude TUI
      // swallows it — the goal then sits in the input box forever, unsubmitted
      // (found live, 2026-07-16). Inside the one queue, crash-consistency still
      // holds: the server finishes the whole branch even if the client dies.
      const sent = [
        `set-option -t ${name} @amrita_goal_sent 1`,
        `paste-buffer -d -b ${buffer} -t ${name}`,
        'run-shell -d 0.5',
        `send-keys -t ${name} Enter`,
        'display-message -p AMRITA_GOAL_SENT',
      ].join(' ; ');
      const already = [
        `delete-buffer -b ${buffer}`,
        'display-message -p AMRITA_GOAL_ALREADY_SENT',
      ].join(' ; ');
      const r = await runTmux([
        'set-buffer',
        '-b',
        buffer,
        '--',
        text,
        ';',
        'if-shell',
        '-F',
        '-t',
        name,
        '#{!=:#{@amrita_goal_sent},1}',
        sent,
        already,
      ]);
      if (r.code !== 0) throw new Error(`tmux send goal failed: ${r.stderr.trim() || r.code}`);
      return r.stdout.includes('AMRITA_GOAL_SENT');
    },
    async killSession(name) {
      const r = await runTmux(['kill-session', '-t', name]);
      if (r.code !== 0 && (await runTmux(['has-session', '-t', name])).code === 0) {
        throw new Error(`tmux kill-session failed: ${r.stderr.trim() || r.code}`);
      }
    },
    async listSessions() {
      const r = await runTmux(['list-sessions', '-F', '#{session_name}']);
      if (r.code !== 0) return [];
      return r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    },
  };
}

/** In-memory fake for tests — scripts the pane, never spawns tmux. */
export class FakeTmuxController implements TmuxController {
  private sessions = new Map<
    string,
    { cwd: string; pane: string; agent: 'claude' | 'codex'; dead: boolean; goalSent: boolean }
  >();
  isAvailable = true;

  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async hasSession(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }
  async sessionState(name: string): Promise<TmuxSessionState> {
    const session = this.sessions.get(name);
    if (!session) {
      return { exists: false, dead: true, agent: null, goalSent: false, cwd: null };
    }
    return {
      exists: true,
      dead: session.dead,
      agent: session.agent,
      goalSent: session.goalSent,
      cwd: session.cwd,
    };
  }
  async newSession(spec: TmuxSessionSpec): Promise<void> {
    this.sessions.set(spec.name, {
      cwd: spec.cwd,
      pane: '',
      agent: spec.agent,
      dead: false,
      goalSent: false,
    });
  }
  /** Rows a fake "visible screen" holds — mirrors a default 80x24 tmux pane. */
  static readonly VISIBLE_ROWS = 24;
  async capturePane(name: string, lines?: number): Promise<string> {
    const session = this.sessions.get(name);
    if (!session) throw new Error('tmux capture-pane failed: session missing');
    // Like the real controller, `lines = 0` is the VISIBLE SCREEN only. The fake
    // models a non-clearing TUI (Codex): the screen is the tail of the history.
    if (lines === 0) {
      return session.pane.split('\n').slice(-FakeTmuxController.VISIBLE_ROWS).join('\n');
    }
    return session.pane;
  }
  async sendKeys(name: string, text: string, opts?: { enter?: boolean }): Promise<void> {
    const s = this.sessions.get(name);
    if (!s || s.dead) throw new Error('tmux send-keys failed: pane is unavailable');
    s.pane += opts?.enter ? `${text}\n` : text;
  }
  async sendGoalOnce(name: string, text: string): Promise<boolean> {
    const s = this.sessions.get(name);
    if (!s || s.dead) throw new Error('tmux send goal failed: pane is unavailable');
    if (s.goalSent) return false;
    s.goalSent = true;
    s.pane += `${text}\n`;
    return true;
  }
  async killSession(name: string): Promise<void> {
    this.sessions.delete(name);
  }
  async listSessions(): Promise<string[]> {
    return [...this.sessions.keys()];
  }
  /** Test helper: push text as if the agent wrote to the pane. */
  emit(name: string, text: string): void {
    const s = this.sessions.get(name);
    if (s) s.pane += text;
  }
  /** Test helper: model an exited executable retained by remain-on-exit. */
  markDead(name: string): void {
    const s = this.sessions.get(name);
    if (s) s.dead = true;
  }
  /** Test helper: model a pane whose process escaped the mandated workspace. */
  setCwd(name: string, cwd: string): void {
    const s = this.sessions.get(name);
    if (s) s.cwd = cwd;
  }
}
