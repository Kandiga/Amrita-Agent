# Amrita Web UI

Status: WO#5.2 — lanes panel over the live event stream.

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
- **Streaming output:** `model.delta` is a *stream-only* event (never persisted — see the protocol's `STREAM_ONLY_TYPES`). The reducer renders accumulated deltas as an in-progress **draft assistant bubble**; a completed `message.agent` then supersedes it. Since WO#5.3 the daemon **emits deltas live** (kernel stream bus, ADR-0016): the mock provider streams word chunks; real adapters stay non-streaming until SSE adapters land. Deltas arrive with `seq: 0`, so they never advance the replay cursor, and `GET /events` never returns them.

The send path still calls `chat.turn` over RPC; the resulting events arrive over the live socket (and a post-send `GET /events` fold makes the turn land even if the socket is offline). The Vite dev proxy upgrades `/events` with `ws: true` so the browser only ever opens a same-origin socket.

## UI areas

- Project sidebar.
- Conversation list and creation.
- Chat transcript and composer.
- Provider selector and status card (shows whether the provider streams live — honest, from
  `providers.list.streaming`).
- Next actions panel — `src/companion.ts`, a **pure, rule-based** derivation over typed state
  (doctor fails → blocker; active/finished lanes → attention; first task / top open task / first
  decision → suggestions). Deliberately not an LLM planner (see
  `docs/strategy/project-companion-roadmap.md`, Stage 0); an empty state honestly says nothing is
  waiting.
- Runtime panel — the daemon's `doctor` report as per-section status chips (`ok` / `needs setup` /
  `failing`) with the warn/fail check details inline. Honest: unconfigured surfaces say "needs
  setup", never pretend readiness.
- Memory panel — FTS search plus a "Remember for this project…" write (`memory.put`, project scope).
- Tasks panel — list, add (`tasks.create`), and complete (`tasks.complete`); done tasks render
  struck-through.
- Decisions panel — the project's append-only decision log (`decisions.list`) plus a "Record a
  decision…" write (`decisions.record`).
- Lanes panel — start/observe/cancel Claude Code lanes (see below).

Knowledge writes carry the active project + conversation as provenance and go through the same
typed RPC/event path as every other surface (no direct store access, no fake data — empty means
empty).

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

## Lanes panel (WO#5.2)

`src/lanes-state.ts` is a pure reducer over `lane.*` events; `App.tsx` renders a Lanes panel fed from
the **same live event stream** as the transcript (lane events are folded in `onEvent` alongside the
transcript reducer, and re-folded by the manual replay). De-dupe is by event id, so reconnects don't
duplicate lanes or progress.

- **Start form:** a goal field, optional budget (`max turns` / `max minutes`), a **Dry run** checkbox
  that is **ON by default** (safe — records the mandate only), and a **Run for real** checkbox that is
  disabled while dry-run is on and labelled "daemon opt-in required" unless `health.lanes.realExecution`
  is true. Starts always use `detach: true`, so the panel observes the lane live.
- **Lane cards:** status badge (spawned/running/merging/completed/aborted), goal, the latest progress
  note, and the final `exit` + summary/reason. A **Cancel** button appears for active lanes and calls
  `lanes.cancel` (a cancelled lane reports `exit: 'cancelled'`).
- Lane RPC calls (`lanesList`/`lanesStart`/`lanesGet`/`lanesCancel` on `RpcClient`) carry the bearer
  token like every other call. No secret value is sent or rendered; lane payloads are secret-free.

## Deferred

- Real-provider SSE streaming (the daemon streams `model.delta` for providers that implement
  `generateStream`; the anthropic/openai adapters do not yet).
- Tool-call UI; Telegram pairing screens.
- Production reverse-proxy and static asset deployment.
