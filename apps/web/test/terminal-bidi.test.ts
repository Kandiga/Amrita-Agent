import { describe, expect, it } from 'vitest';
import { makeTerminalBidi, reorderTerminalLine } from '../src/terminal-bidi.ts';

const ESC = '\u001b'; // ANSI escape, written explicitly

describe('terminal RTL reorder (ADR-0052 follow-up)', () => {
  it('reorders a plain Hebrew line logical->visual (reads RTL when painted LTR)', () => {
    const logical = 'להריץ שוב';
    const visual = reorderTerminalLine(logical);
    expect(visual).not.toBe(logical);
    // reversing the visual back yields the logical order (round-trip sanity)
    expect([...visual].reverse().join('')).toBe(logical);
  });

  it('leaves pure-English and code lines untouched', () => {
    expect(reorderTerminalLine('git status --short')).toBe('git status --short');
    expect(reorderTerminalLine('const x = 1;')).toBe('const x = 1;');
  });

  it('NEVER touches a line with ANSI/cursor escapes (TUI safety)', () => {
    const clearScreen = `${ESC}[2J${ESC}[Hמסך מלא`;
    expect(reorderTerminalLine(clearScreen)).toBe(clearScreen);
    const colored = `${ESC}[31mשגיאה${ESC}[0m`;
    expect(reorderTerminalLine(colored)).toBe(colored);
  });

  it('streams: only complete lines are reordered; a split word is not half-done', () => {
    const bidi = makeTerminalBidi();
    expect(bidi('להר')).toBe(''); // held — no newline yet
    expect(bidi('יץ שוב\n')).toBe(`${reorderTerminalLine('להריץ שוב')}\n`);
  });

  it('streams: an escape/cursor chunk flushes verbatim (spinner/TUI never waits)', () => {
    const bidi = makeTerminalBidi();
    const frame = `${ESC}[1G${ESC}[2Kעובד…`;
    expect(bidi(frame)).toBe(frame);
  });
});
