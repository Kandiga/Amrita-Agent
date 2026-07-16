import { type ChildProcess, spawn } from 'node:child_process';
import { redactPane } from '@amrita/lanes';

/**
 * The embedded-terminal bridge (ADR-0052): one browser socket ⇄ one
 * `tmux -C attach-session` child on the dedicated `amrita` socket.
 *
 * Control mode is the load-bearing choice: it works over PLAIN PIPES (verified
 * on tmux 3.4 — no pty, no native dependency), emits pane output as `%output`
 * events, and accepts commands on stdin. Input never becomes a command string:
 * the browser's raw key bytes are hex-encoded into `send-keys -H`, so arrows,
 * Esc, Tab, slash-commands — every byte — arrive exactly, and injection is
 * impossible by construction. Output passes best-effort `redactPane` (ADR-0049's
 * stated honest limit: a live screen is equivalent to `tmux attach`). Nothing
 * here is persisted.
 */

/** `%output %<pane> <octal-escaped bytes>` → the unescaped payload, else null. */
export function parseControlOutput(line: string): string | null {
  if (!line.startsWith('%output ')) return null;
  const space = line.indexOf(' ', '%output '.length);
  if (space < 0) return null;
  return unescapeTmuxOutput(line.slice(space + 1));
}

/** tmux control mode octal-escapes non-printables (`\015`) and backslashes. */
export function unescapeTmuxOutput(escaped: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < escaped.length; i++) {
    const ch = escaped[i] ?? '';
    if (ch === '\\') {
      const oct = escaped.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(Number.parseInt(oct, 8));
        i += 3;
        continue;
      }
      if (escaped[i + 1] === '\\') {
        bytes.push(0x5c);
        i += 1;
        continue;
      }
    }
    // Multi-byte UTF-8 arrives as literal characters; re-encode faithfully.
    for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}

/** UTF-8 string → the space-separated hex argv for `send-keys -H`. */
export function toHexArgs(data: string): string[] {
  return [...Buffer.from(data, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
}

export interface TerminalBridge {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface TerminalBridgeOpts {
  /** Validated upstream: ^[A-Za-z0-9_-]+$ (the derived `amrita-<laneId>`). */
  sessionName: string;
  onOutput(data: string): void;
  onExit(reason: string): void;
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
}

export function attachTerminalBridge(opts: TerminalBridgeOpts): TerminalBridge {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.sessionName)) {
    throw new Error('invalid tmux session name');
  }
  const doSpawn = opts.spawnImpl ?? spawn;
  const child: ChildProcess = doSpawn(
    'tmux',
    ['-C', '-L', 'amrita', 'attach-session', '-t', opts.sessionName],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let closed = false;
  let buffer = '';

  // A control-mode attach streams DELTAS only — a reconnecting browser would see
  // a blank screen until the next repaint (found live: after a refresh only the
  // agent's spinner line painted). Hydrate with the CURRENT screen first
  // (capture-pane -e keeps colors), and buffer any deltas that race the capture
  // so ordering is preserved: snapshot, then deltas.
  let hydrated = false;
  const pendingDeltas: string[] = [];
  const emitOutput = (data: string): void => {
    if (hydrated) opts.onOutput(data);
    else pendingDeltas.push(data);
  };
  const finishHydration = (snapshot: string): void => {
    if (closed || hydrated) return;
    hydrated = true;
    if (snapshot.length > 0) {
      // Clear + home, then the captured screen (LF → CRLF for the terminal).
      opts.onOutput(`\u001b[2J\u001b[H${redactPane(snapshot.replace(/\n/g, '\r\n'))}`);
    }
    for (const delta of pendingDeltas) opts.onOutput(delta);
    pendingDeltas.length = 0;
  };
  const capture: ChildProcess = doSpawn(
    'tmux',
    ['-L', 'amrita', 'capture-pane', '-e', '-p', '-t', opts.sessionName],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let snapshot = '';
  capture.stdout?.on('data', (chunk: Buffer) => {
    snapshot += chunk.toString('utf8');
  });
  capture.on('close', () => finishHydration(snapshot));
  capture.on('error', () => finishHydration(''));

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const payload = parseControlOutput(line);
      if (payload !== null && payload.length > 0) {
        // Best-effort secret scrub before the bytes leave the daemon (ADR-0049).
        emitOutput(redactPane(payload));
      } else if (line.startsWith('%exit')) {
        finish('the tmux session ended');
      }
      nl = buffer.indexOf('\n');
    }
  });
  child.on('close', () => finish('the terminal bridge closed'));
  child.on('error', () => finish('tmux is unavailable'));

  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    opts.onExit(reason);
  };

  const command = (cmd: string): void => {
    if (closed) return;
    child.stdin?.write(`${cmd}\n`);
  };

  return {
    write(data: string): void {
      // Bytes → hex → send-keys -H: never a shell, never a tmux command string.
      const capped = data.slice(0, 8192);
      const hex = toHexArgs(capped);
      // tmux command lines have generous limits; still chunk defensively.
      for (let i = 0; i < hex.length; i += 128) {
        command(`send-keys -t ${opts.sessionName} -H ${hex.slice(i, i + 128).join(' ')}`);
      }
    },
    resize(cols: number, rows: number): void {
      const c = Math.max(20, Math.min(500, Math.floor(cols)));
      const r = Math.max(5, Math.min(300, Math.floor(rows)));
      command(`refresh-client -C ${c}x${r}`);
    },
    close(): void {
      finish('closed by the operator');
    },
  };
}
