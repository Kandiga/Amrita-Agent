# Amrita Web UI

Status: WO#4.1 skeleton.

The web app is a React/Vite operator UI over the `amritad` HTTP control surface. It is intentionally thin: all persistence, provider calls, memory search, task state and event replay stay in the daemon/kernel.

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
- `GET /events?conversationId=...&sinceSeq=...` for replaying message events into the transcript.

No secret values are sent from or rendered by the web app. Provider status is boolean/config metadata only.

## UI areas

- Project sidebar.
- Conversation list and creation.
- Chat transcript and composer.
- Provider selector and status card.
- Memory search panel.
- Tasks panel.
- Lane placeholder for future tool/Claude Code/Telegram surfaces.

The UI uses `dir="auto"`-style helpers for Hebrew/English mixed text and keeps raw protocol/debug details out of the primary chat flow.

## Deferred

- WebSocket live streaming consumption in the browser.
- Token streaming.
- Tool-call/lane UI.
- Telegram pairing screens.
- Auth/session management.
- Production reverse-proxy and static asset deployment.
