import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  attachTerminalBridge,
  parseControlOutput,
  toHexArgs,
  unescapeTmuxOutput,
} from '../src/terminal-bridge.ts';

/** ADR-0052 — the embedded-terminal bridge: pure codecs + a real-tmux round-trip. */

describe('tmux control-mode codecs (pure)', () => {
  it('unescapes octal control bytes and backslashes', () => {
    expect(unescapeTmuxOutput('hello')).toBe('hello');
    expect(unescapeTmuxOutput('a\\015\\012b')).toBe('a\r\nb');
    expect(unescapeTmuxOutput('esc \\033[31m red')).toBe('esc \x1b[31m red');
    expect(unescapeTmuxOutput('back\\\\slash')).toBe('back\\slash');
    expect(unescapeTmuxOutput('שלום ❯')).toBe('שלום ❯'); // UTF-8 passes through
  });

  it('parses only %output lines and ignores control chatter', () => {
    expect(parseControlOutput('%output %2 hi\\015')).toBe('hi\r');
    expect(parseControlOutput('%begin 123 9 1')).toBeNull();
    expect(parseControlOutput('%session-changed $2 x')).toBeNull();
    expect(parseControlOutput('random noise')).toBeNull();
  });

  it('hex-encodes every byte — input can never become a command string', () => {
    expect(toHexArgs('2\r')).toEqual(['32', '0d']);
    expect(toHexArgs('\x1b[A')).toEqual(['1b', '5b', '41']); // Up arrow
    // A hostile "input" is just bytes; there is nothing to inject.
    expect(toHexArgs('; kill-session -t x')).toEqual(
      [...Buffer.from('; kill-session -t x', 'utf8')].map((b) => b.toString(16).padStart(2, '0')),
    );
  });

  it('refuses a malformed session name outright', () => {
    expect(() =>
      attachTerminalBridge({ sessionName: 'bad name; rm', onOutput: () => {}, onExit: () => {} }),
    ).toThrow(/invalid tmux session name/);
  });
});

const tmuxAvailable = (() => {
  try {
    execFileSync('tmux', ['-V'], { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!tmuxAvailable)('terminal bridge on real tmux (ADR-0052)', () => {
  it('round-trips: typed bytes reach the pane, pane output streams back', async () => {
    const name = 'amrita-termbridge-test';
    execFileSync('tmux', ['-L', 'amrita', 'new-session', '-d', '-s', name, '-c', '/tmp', 'cat']);
    const chunks: string[] = [];
    let exited = '';
    try {
      const bridge = attachTerminalBridge({
        sessionName: name,
        onOutput: (d) => chunks.push(d),
        onExit: (r) => {
          exited = r;
        },
      });
      await new Promise((r) => setTimeout(r, 400)); // let the attach settle
      bridge.write('ping-42\r');
      await new Promise((r) => setTimeout(r, 700));
      bridge.resize(100, 30);
      await new Promise((r) => setTimeout(r, 300));
      bridge.close();
      expect(chunks.join('')).toContain('ping-42'); // cat echoed through %output
      expect(exited).toBeTruthy();
    } finally {
      try {
        execFileSync('tmux', ['-L', 'amrita', 'kill-session', '-t', name]);
      } catch {
        /* already gone */
      }
    }
  });
});
