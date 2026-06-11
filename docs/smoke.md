# Smoke: the usable Amrita loop

A ten-minute, end-to-end walkthrough of Amrita v2 as a product: start the runtime, open the
operator UI, chat with live streaming, look at project knowledge, run a safe lane, and check
runtime health. Nothing here needs a real provider key or a real Claude Code run — the loop is
honest about what is and isn't configured.

## 1. Start the daemon

```bash
cd /path/to/amrita-v2
pnpm install
pnpm amritad -- --db ~/.amrita/amrita.db --http --port 7460
```

Startup prints three things, once:

- `amritad http listening on http://127.0.0.1:7460`
- the **bearer token** — either `auth enabled via AMRITA_AUTH_TOKEN` (you set one) or a generated
  token printed once (copy it now; it is never written to a file, the DB, or a log);
- the lane posture: `lanes real-execution disabled` (the safe default).

Sanity check (the only public route):

```bash
curl -s http://127.0.0.1:7460/health | head -c 200
```

## 2. Open the web UI

```bash
pnpm --filter @amrita/web dev   # http://localhost:5173 — proxies /rpc and /events to :7460
```

Paste the bearer token into the **Access token** panel (right column). It is stored in
`localStorage` only and shown masked. A wrong/missing token shows an honest "Unauthorized" banner,
not a broken page.

## 3. Project → conversation → chat

- The sidebar boots into the `system` project and creates a first conversation if none exists.
- The connection pill in the top bar reads **Live** when the WebSocket event stream is up;
  clicking it forces a manual replay (the offline fallback).
- Send a message. With the default **mock** provider the reply **streams in token chunks**
  (stream-only `model.delta` events) into a draft bubble, then settles as the persisted assistant
  message. Mixed Hebrew/English renders with per-element direction.
- Refresh the page: the transcript replays identically from the event log (`GET /events`) — the
  stream is cosmetic, the log is the truth.

## 4. Project knowledge

In the right column:

- **Memory** — type into "Remember for this project…" and save; then search for a word of it.
  FTS results come back ranked. Empty means empty — no fake data.
- **Tasks** — add a task, then press **Done**; it re-lists struck-through with status `done`.
- **Decisions** — record one; the append-only decision log lists it.

The same knowledge is available from the CLI against the same DB:

```bash
pnpm amrita -- task list --project system --db ~/.amrita/amrita.db
pnpm amrita -- memory search <word> --db ~/.amrita/amrita.db
```

## 5. Run a safe lane (dry-run)

In the **Lanes** panel: type a goal, leave **Dry run** checked (the default), press **Start
lane**. A lane card appears from the live event stream with the mandate recorded and status
`spawned` — nothing executed. Unchecking dry-run *without* daemon opt-in ends the lane safely as
`aborted` with a clear reason; the **Run for real** checkbox says "(daemon opt-in required)"
unless the daemon was started with `AMRITA_LANES_ALLOW_REAL_EXECUTION=1`. Active lanes show a
**Cancel** button (`exit: cancelled`).

## 6. Inspect runtime status

- **Web:** the **Runtime** panel shows the doctor report — per-section chips (`ok` / `needs
  setup` / `failing`). On a fresh install expect: store ✓, mock provider ✓, anthropic/openai
  "needs setup", lanes ✓ (disabled = safe default), web channel ✓, telegram "needs setup" (its
  live bot runner is not bundled yet — honest), auth ✓/needs-setup depending on
  `AMRITA_AUTH_TOKEN`.
- **CLI:**

```bash
pnpm amrita -- doctor --db ~/.amrita/amrita.db
```

prints the same checks as `◆` sections with `✓ / ! / ✗` marks and a numbered "run these to fix"
footer with exact commands.

## What "configured" would add (not required for this smoke)

- A real provider: `amrita account connect --provider anthropic` + `amrita account bind-secret
  <ACCOUNT_ID> ANTHROPIC_API_KEY` + the env var in the **daemon's** shell. Amrita stores only the
  env-var *name*; doctor turns ✓ when the var is present.
- Real lane execution: start the daemon with `AMRITA_LANES_ALLOW_REAL_EXECUTION=1` (workspace-
  confined, env-scrubbed, budgeted, cancellable — see ADR-0015).
