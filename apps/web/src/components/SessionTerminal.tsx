import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { terminalServerFrameSchema } from '@amrita/protocol';
import { useEffect, useRef, useState } from 'react';

/**
 * The embedded interactive session terminal (ADR-0052). This IS the CLI: every
 * keystroke (arrows, Esc, Tab, slash-commands) goes to the tmux pane as raw
 * bytes over the dedicated `/lanes/<id>/terminal` socket, and the pane's ANSI
 * stream renders in xterm.js. Nothing is persisted on either side.
 *
 * The look follows Claude's web artifact panel (Mobbin reference): a warm-ink
 * rounded panel inside bone-white chrome — the terminal stays faithful, the
 * frame around it speaks claude.ai.
 */

/** Claude web palette for the terminal itself (bone chrome is the card's job). */
const CLAUDE_THEME = {
  background: '#1f1e1d',
  foreground: '#eceae4',
  cursor: '#d97757',
  cursorAccent: '#1f1e1d',
  selectionBackground: '#4a4741',
  black: '#1f1e1d',
  red: '#e2654e',
  green: '#7d9b76',
  yellow: '#d9a75f',
  blue: '#6d9bc3',
  magenta: '#b587b0',
  cyan: '#7fb5a8',
  white: '#eceae4',
  brightBlack: '#6e6d66',
  brightRed: '#f08a75',
  brightGreen: '#9cb996',
  brightYellow: '#e8c088',
  brightBlue: '#92b7d8',
  brightMagenta: '#cda5c8',
  brightCyan: '#a2cfc3',
  brightWhite: '#faf9f5',
} as const;

type LinkState = 'connecting' | 'connected' | 'closed';

interface SessionTerminalProps {
  projectId: string;
  laneId: string;
  authToken?: string | undefined;
  /** Bumps when the operator hits "Reconnect". */
  epoch: number;
}

export function SessionTerminal({ projectId, laneId, authToken, epoch }: SessionTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [link, setLink] = useState<LinkState>('connecting');
  const [exitReason, setExitReason] = useState('');

  useEffect(() => {
    void epoch; // a "Reconnect" click bumps the epoch to tear down and redial
    const host = hostRef.current;
    if (!host || typeof WebSocket === 'undefined') return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        "'SF Mono', ui-monospace, 'Cascadia Code', Menlo, Consolas, 'Liberation Mono', monospace",
      theme: { ...CLAUDE_THEME },
      allowProposedApi: false,
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const base = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    const params = new URLSearchParams({ projectId });
    if (authToken) params.set('token', authToken);
    const ws = new WebSocket(`${base}/lanes/${laneId}/terminal?${params.toString()}`);
    let alive = true;
    setLink('connecting');
    setExitReason('');

    ws.onopen = () => {
      if (!alive) return;
      setLink('connected');
      ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (m) => {
      if (!alive) return;
      try {
        const frame = terminalServerFrameSchema.parse(JSON.parse(String(m.data)));
        if (frame.t === 'output') term.write(frame.data);
        else setExitReason(frame.reason);
      } catch {
        /* junk frames are dropped, never interpreted */
      }
    };
    const onClosed = () => {
      if (!alive) return;
      setLink('closed');
    };
    ws.onclose = onClosed;
    ws.onerror = onClosed;

    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', data }));
    });
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {
        /* transient layout race */
      }
    });
    observer.observe(host);

    return () => {
      alive = false;
      observer.disconnect();
      dataSub.dispose();
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      term.dispose();
    };
  }, [projectId, laneId, authToken, epoch]);

  return (
    <div className="session-terminal-wrap" data-link={link}>
      <div ref={hostRef} className="session-terminal" aria-label="interactive session terminal" />
      {link !== 'connected' ? (
        <div className="session-terminal-veil">
          {link === 'connecting' ? 'Connecting to the live session…' : exitReason || 'Disconnected'}
        </div>
      ) : null}
    </div>
  );
}
