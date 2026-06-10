# Amrita Web UI

Status: WO#4.2 — live event stream.

The web app is a React/Vite operator UI over the `amritad` HTTP control surface. It is intentionally thin: all persistence, provider calls, memory search, task state and event replay stay in the daemon/kernel. The transcript is driven by the daemon's **live event stream** (WebSocket), not by polling.

## Package

- Path: `apps/web`
- Name: `@amrita/web`
- Commands:
  - `pnpm --filter @amrita/web dev`
  - `pnpm --filter @amrita/web typecheck`
  - `pnpm --filter @amrita/web test`
  - `pnpm --filter @amrita/web build`

## Runtime contract

The UI speaks only to the daemon HTTP API:

- `POST /rpc` for JSON-RPC methods such as:
  - `project.list`
  - `project.ensure`
  - `conversation.list`
  - `conversation.create`
  - `chat.turn`
  - `providers.list`
  - `memory.search`
  - `tasks.list`
- `GET /events?conversationId=...&sinceSeq=...` for replaying message events into the transcript (also the offline fallback).
- `WS /events/ws?conversationId=...&sinceSeq=...` for the live event stream (see below).

No secret values are sent from or rendered by the web app. Provider status is boolean/config metadata only.

## Live event stream (WO#4.2)

`src/stream.ts` (`openEventStream`) is a small, typed WebSocket client; `src/live-transcript.ts` is the pure reducer that folds frames into the transcript. App wiring lives in `App.tsx`.

- **Frames** (authoritative: `packages/daemon/src/http.ts`): `{ t: 'event', event }` — one per replayed *and* live event — followed by a `{ t: 'replayed', conversationId, sinceSeq }` marker once history is drained. Malformed frames are dropped, never thrown.
- **De-dupe:** the reducer keys on event `id`. A reconnect replays history the client already has; those events are folded again and change nothing, so reconnects never duplicate messages.
- **Reconnect:** bounded exponential backoff. On every (re)connect the client resumes from the highest `seq` it has seen (`?sinceSeq=`). After the retry budget is exhausted the stream reports state `error`.
- **Connection states** (a status pill in the top bar): `connecting` · `open` (“Live”) · `reconnecting` · `error` (“Offline”) · `closed`. Clicking the pill triggers a manual `GET /events` replay — the offline fallback.
- **Streaming output:** `model.delta` is a *stream-only* event (never persisted — see the protocol's `STREAM_ONLY_TYPES`). The reducer renders accumulated deltas as an in-progress **draft assistant bubble**; a completed `message.agent` then supersedes it. The daemon does not emit `model.delta` yet, so real token streaming is **deferred** — but the client path and a fake-stream test already cover it.

The send path still calls `chat.turn` over RPC; the resulting events arrive over the live socket (and a post-send `GET /events` fold makes the turn land even if the socket is offline). The Vite dev proxy upgrades `/events` with `ws: true` so the browser only ever opens a same-origin socket.

## UI areas

- Project sidebar.
- Conversation list and creation.
- Chat transcript and composer.
- Provider selector and status card.
- Memory search panel.
- Tasks panel.
- Lane placeholder for future tool/Claude Code/Telegram surfaces.

The UI uses `dir="auto"`-style helpers for Hebrew/English mixed text and keeps raw protocol/debug details out of the primary chat flow.

## Access token (WO#4.3)

The daemon's control surface requires a bearer token (see [runtime.md](runtime.md#auth-guard-wo43)).
`src/auth.ts` keeps the token in `localStorage` only; `App.tsx` exposes an **Access token** panel:

- the token is entered in a masked (`type="password"`) field and stored locally — it is **never logged**
  to the console and **never rendered in full** (the panel shows a fixed bullet mask, `maskToken`);
- `RpcClient` sends it as `Authorization: Bearer …` on `/rpc` and `/events`; the WS client passes it as
  the `?token=` query parameter (browsers cannot set WS headers);
- a `401/403` is mapped to a value-free `unauthorized` error that surfaces the panel (and an
  “Unauthorized” banner) instead of a raw error line; a successful load clears it;
- saving an empty token clears it. The token is *local control-surface config*, not a provider secret.

## Deferred

- Real token streaming (`model.delta` emission from the daemon; the client renders it already).
- Tool-call/lane UI.
- Telegram pairing screens.
- Production reverse-proxy and static asset deployment.
