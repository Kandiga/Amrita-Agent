import bidiFactory from 'bidi-js';

/**
 * High-quality RTL for the embedded terminal (ADR-0052 follow-up).
 *
 * xterm.js — like every terminal emulator — is an LTR cell grid with no BiDi:
 * the Claude/Codex CLIs emit Hebrew in LOGICAL order assuming an LTR terminal,
 * so each line paints reversed. There is no config flag (verified against
 * @xterm/xterm@6 ITerminalOptions). The honest fix is the Unicode Bidirectional
 * Algorithm applied per line, logical->visual, BEFORE xterm renders it.
 *
 * SAFETY: reorder ONLY complete lines that are plain printable text (no ESC /
 * cursor-addressing / SGR). A full-screen TUI redraw (menus, boxes, cursor
 * moves) is passed through UNCHANGED — reordering it would corrupt the cursor
 * math and make things worse. So streaming Hebrew output reads correctly, and
 * interactive TUI frames are never damaged. Pure + unit-tested.
 */

const bidi = bidiFactory();
/** Hebrew + Arabic + presentation forms — the RTL scripts a CLI is likely to emit. */
const RTL_SCRIPT = /[֐-׿؀-ۿ܀-ݏיִ-﷿ﹰ-﻿]/;
/** ESC or a formatting C0 control (not \t \n \r) → the line has cursor/ANSI intent. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting ANSI/ESC is the point
const HAS_CONTROL = /[\u001b\u0000-\u0008\u000b\u000c\u000e-\u001f\u009b]/;

/** Reorder ONE line logical->visual for an LTR terminal. Untouched unless it is
 *  plain text containing an RTL run. */
export function reorderTerminalLine(line: string): string {
  if (!RTL_SCRIPT.test(line)) return line; // no Hebrew/Arabic -> nothing to do
  if (HAS_CONTROL.test(line)) return line; // ANSI/cursor/TUI -> never risk it
  const levels = bidi.getEmbeddingLevels(line);
  const segments = bidi.getReorderSegments(line, levels);
  if (segments.length === 0) return line;
  const chars = [...line];
  for (const [start, end] of segments) {
    const reversed = chars.slice(start, end + 1).reverse();
    for (let i = 0; i < reversed.length; i++) chars[start + i] = reversed[i] as string;
  }
  return chars.join('');
}

/**
 * A stateful line-buffering reorder for a terminal stream. Data arrives in
 * arbitrary chunks; we only reorder text that has reached a line terminator, so
 * a Hebrew word split across two writes is never half-reordered. Any chunk
 * carrying an escape/control is flushed verbatim (a spinner/TUI must not wait).
 */
export function makeTerminalBidi(): (chunk: string) => string {
  let pending = '';
  return (chunk: string): string => {
    if (HAS_CONTROL.test(chunk)) {
      const out = pending + chunk;
      pending = '';
      return out;
    }
    pending += chunk;
    let out = '';
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl);
      out += `${reorderTerminalLine(line)}\n`;
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');
    }
    return out; // hold the incomplete tail until its newline arrives
  };
}
