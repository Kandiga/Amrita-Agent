# ADR-0043 — The Claude Ecosystem panel (not a fake terminal)

- **Status:** accepted (2026-07-13)
- **Context:** the operator circled the activity feed on a screenshot, believing it was
  a "remote-control session of Claude Code CLI," and asked for a view of "exactly what
  Claude Code CLI / a Claude Code session shows — connections, abilities, skills, MCP" plus
  a button to "open the session window."

  **Correcting the premise matters for what gets built.** The circled area is
  `apps/web/src/activity.ts` — a pure reducer over Amrita's own turn/lane events, not a CLI
  session. And there is no persistent, attachable Claude Code process to open a window
  into: chat turns spawn `claude -p --output-format stream-json` **one-shot per turn**
  (`packages/daemon/src/provider.ts`), and lanes spawn `claude --print <goal> --allowedTools
  …` one-shot per run (`packages/lanes/src/claude-code.ts`). Building a live interactive
  terminal (pty + xterm.js) would mean a NEW execution path outside the lane/approval
  contract — the exact thing R4 explicitly rejected ("the lane console IS the remote Claude
  window... never a second execution path", ledger R4). That call stands.

## Decision

Build the **Claude Ecosystem panel**: a floating, collapsible drawer showing 100%-real,
already-sourced data — never simulated state, never a fake terminal.

1. **Data — no new execution path, one new field:**
   - Runtime (state/version/login) — `runtime.status` → `codingRuntimes` (existing).
   - MCP — `connectors.status` → the `claude-mcp` entry (ADR-0040/G6, existing).
   - Skills — `skills.list` (ADR-0035; the client method existed but had **zero UI
     consumers** until now — this panel is its first caller).
   - Abilities (tools) — the one real gap. Chat grants **zero tools** structurally (`-p`
     carries no `--allowedTools`); lanes grant the server-configured
     `AMRITA_LANES_ALLOWED_TOOLS` list. That list was previously known only inside
     `AmritaKernel`'s constructor scope. **Wire addition:** `codingRuntimeStatusSchema`
     gains an optional `allowedTools: string[]` (tool NAMES, not secret-shaped — safe to
     expose, unlike a key), populated on the `claude-code` entry only (codex has no
     tool-allowlist concept; it sandboxes by directory, not by tool). The kernel stores
     `laneAllowedTools` (mirrors `laneWorkspacesRoot` from ADR-0039) and threads it into
     `getRuntimesStatus`. No new RPC verb — an SSOT-correct extension of an existing one.
   - Session — when a Claude Code lane is running/most-recent for the open conversation,
     the SAME `LanesState`/lane-console rendering already in `App.tsx` is reused verbatim
     (imported, not re-derived) inside a "Session" tab. No active lane → an honest empty
     state, never a fabricated "connected" terminal.
2. **SSOT cleanup:** the runtime/connector state-label and badge-class maps were duplicated
   nowhere yet but were about to be needed in two components — extracted from
   `SettingsRuntimeHub.tsx` into the existing shared `providers-view.ts` (pure, tested,
   DOM-free), which both the Hub and the new panel import.
3. **Placement (design/psychology):** a small collapsed launcher pill, bottom-right of the
   chat column, above the composer — never overlapping it, never claiming the canvas. This
   mirrors the quiet secondary-session-launcher pattern (Intercom/Crisp/claude.ai's own
   corner launchers): invisible until wanted, a single live-status dot (not a number badge)
   only when the runtime is ready, no motion/attention-grab on idle. Opening it slides up a
   bounded drawer over the chat column (never a full-screen modal) so canvas/project context
   stays visible behind it; closes on Esc, backdrop click, or ✕. On mobile it becomes a
   bottom-sheet reachable from the same launcher, sized to leave the 4-tab bar visible.

## Invariants & guards

- No new execution path: the panel only reads existing RPCs/state; it cannot start, stop,
  or message a CLI session on its own.
- `allowedTools` is tool NAMES only, sourced from the daemon's own already-parsed list —
  never re-parses the env var, never exposes a value that could be secret-shaped.
- Skills/MCP copy states "registered, not executed" / "configured, not connected" exactly
  per their existing ADR-0035/0022 honesty rules — the panel adds no new claims.
- Protocol test proves the wire field; daemon test proves the kernel→runtimes threading;
  web test proves the extracted badge/label helpers are behaviorally identical post-move.

## Rollback

Additive: delete the panel component + launcher wiring to remove the surface; the
`allowedTools` field is optional so older clients ignore it; `providers-view.ts` extraction
is a pure refactor (revert by inlining back into the Hub).
