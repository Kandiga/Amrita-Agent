# ADR-0052: Embedded interactive session terminal

- **Status:** Accepted
- **Date:** 2026-07-16
- **Builds on:** ADR-0049 (tmux sessions), ADR-0050 (Session Workspace), ADR-0051 (relay)

## Context

The Session Workspace showed a 1s pane SNAPSHOT plus a separate text-input box.
That is a viewer, not a terminal: no arrow keys, no Esc/Tab, no slash commands —
an interactive Claude Code menu could only be answered with the digit trick, and
CLI surfaces like `/model`, `/mcp`, `/skills` were unreachable. The operator
asked for FULL CLI control from inside the product, and for the session to look
like Claude's web app rather than a raw terminal.

## Decision

1. **A real terminal bridge, not a richer viewer.** A dedicated WebSocket
   endpoint `GET /lanes/<laneId>/terminal?projectId=…` bridges the browser to the
   session's tmux pane through **tmux control mode** (`tmux -C attach`, verified
   to work over pipes on tmux 3.4 — no pty, no native deps). Output: `%output`
   events are unescaped and forwarded. Input: raw browser key bytes are
   **hex-encoded** and sent as `send-keys -H` — bytes, never a command string, so
   arrows/Esc/Tab/slash-commands all work and injection is impossible by
   construction. Resize maps to `refresh-client -C <cols>x<rows>`.

2. **Same authorization as every session surface (ADR-0050).** The upgrade
   validates the bearer token, then requires the lane to belong to the requested
   project, be interactive (`*-tmux`), and be non-terminal — foreign and missing
   lanes are indistinguishable. One bridge child per socket, killed on
   disconnect; a dead session closes the socket honestly.

3. **The operator typing IS the attended premise.** ADR-0049's safety model for
   interactive sessions is operator attendance. The automated guards (runner,
   relay) still never type into login/trust screens; the human at the terminal
   is exactly who MAY answer them (`/login` included). Terminal I/O is never
   persisted; output chunks pass best-effort `redactPane` (ADR-0049's stated
   honest limit: a live screen is equivalent to `tmux attach`).

4. **Typed frames, tiny contract.** The endpoint speaks a dedicated frame pair
   in `@amrita/protocol` (`terminalClientFrameSchema`: `input`/`resize`;
   `terminalServerFrameSchema`: `output`/`exit`), parsed on both sides per the
   schema-first constitution. It is not part of the events WS union.

5. **Web look = Claude's web chrome around a faithful terminal.** The pane
   renders in xterm.js themed to Claude's web palette (bone chrome `#FAF9F5`,
   ink panel, coral accent) inside an artifact-style card — header with agent,
   goal and state, rounded dark body, footer controls (Mobbin: Claude web
   artifact panel). The snapshot path (ADR-0050) remains for recovered/terminal
   sessions and for Amrita's own eyes (ADR-0051).

## Consequences

- Every Claude/Codex CLI capability is available in-product: model picker,
  skills, MCP, menus, interrupts (Esc), history — because the surface IS the CLI.
- A second live-output channel exists alongside `lane.pane` (which stays for
  cards/briefs). Both are ephemeral; neither persists.
- The browser can now send arbitrary bytes to an approved session — bounded by
  the same project-scoped auth, the approval that gated the session's creation,
  and operator attendance. Input is never logged or stored.
- xterm.js (`@xterm/xterm`, `@xterm/addon-fit`) joins the web bundle (~280 KB
  raw, pure JS, no native code).

## Verification

Pure: control-line parsing, octal unescaping, hex encoding (round-trip,
injection shapes). Daemon: upgrade auth (no token / foreign project / non-tmux
lane / missing session all refuse identically), real-tmux round-trip
(skipIf-gated): attach → type → `%output` echo. Web: build + browser E3 — arrow
keys drive a real Claude menu, `/model` opens inside the session, resize
reflows, disconnect falls back to the snapshot view.
