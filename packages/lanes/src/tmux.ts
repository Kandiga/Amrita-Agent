import { type ChildProcess, spawn } from 'node:child_process';
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
  /** The command to run in the pane, as argv (execvp — NOT a shell string). */
  command: string[];
}

export interface TmuxController {
  /** Is tmux installed and runnable? */
  available(): Promise<boolean>;
  hasSession(name: string): Promise<boolean>;
  newSession(spec: TmuxSessionSpec): Promise<void>;
  /** Current pane content (a snapshot, not a delta). `lines` caps the tail. */
  capturePane(name: string, lines?: number): Promise<string>;
  /** Type literal text into the pane (no shell interpretation), optionally + Enter. */
  sendKeys(name: string, text: string, opts?: { enter?: boolean }): Promise<void>;
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

/** The real tmux controller. Fixed argv, no shell, dedicated socket, scrubbed env. */
export function createNodeTmuxController(): TmuxController {
  return {
    async available() {
      return (await runTmux(['-V'])).code === 0;
    },
    async hasSession(name) {
      return (await runTmux(['has-session', '-t', name])).code === 0;
    },
    async newSession(spec) {
      // A bare login shell in cwd; the runner then send-keys the agent + goal, so the
      // (untrusted) goal never touches a shell command line. remain-on-exit keeps the
      // pane (and its final output) after the agent exits, for the closing capture.
      const r = await runTmux([
        'new-session',
        '-d',
        '-s',
        spec.name,
        '-c',
        spec.cwd,
        ...spec.command,
      ]);
      if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || r.code}`);
      await runTmux(['set-option', '-t', spec.name, 'remain-on-exit', 'on']);
    },
    async capturePane(name, lines = 200) {
      // -p print to stdout, -J join wrapped lines, -S -<lines> start N lines back.
      const r = await runTmux(['capture-pane', '-p', '-J', '-t', name, '-S', `-${lines}`]);
      return r.code === 0 ? r.stdout : '';
    },
    async sendKeys(name, text, opts) {
      // -l literal: the text is typed as-is, never interpreted as tmux key names or
      // a shell command. Enter is a separate, explicit key.
      await runTmux(['send-keys', '-t', name, '-l', text]);
      if (opts?.enter) await runTmux(['send-keys', '-t', name, 'Enter']);
    },
    async killSession(name) {
      await runTmux(['kill-session', '-t', name]);
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
  private sessions = new Map<string, { cwd: string; pane: string }>();
  isAvailable = true;

  async available(): Promise<boolean> {
    return this.isAvailable;
  }
  async hasSession(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }
  async newSession(spec: TmuxSessionSpec): Promise<void> {
    this.sessions.set(spec.name, { cwd: spec.cwd, pane: '' });
  }
  async capturePane(name: string): Promise<string> {
    return this.sessions.get(name)?.pane ?? '';
  }
  async sendKeys(name: string, text: string, opts?: { enter?: boolean }): Promise<void> {
    const s = this.sessions.get(name);
    if (s) s.pane += opts?.enter ? `${text}\n` : text;
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
}
