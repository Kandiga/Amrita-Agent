# Channels

All channels converge on the same gateway, the same projects, and the same memory. Commands are uniform everywhere: `/projects`, `/main`, `/new`, `/where`, `/sessions`, `/stop`.

## Telegram

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token
2. `amrita setup` → enable Telegram → paste token (or Settings → Channels in the web UI)
3. Restart the daemon. `amrita doctor` should show `✓ Telegram @yourbot`

### How it behaves

- **Default context is main Amrita** — a personal assistant not tied to any project.
- `/projects` sends your projects as **buttons**. Tapping one switches the whole conversation to that project's Amrita: its memory vault, its files, its tasks.
- Project replies are prefixed with `📁 <project>` so you always know where you are; `/where` answers explicitly.
- `/main` returns to main Amrita. `/new` starts a fresh session in the current context.
- Long tasks keep running after you close Telegram; results arrive as messages. `/stop` interrupts. Sending a new message also interrupts the previous run.
- Long-polling transport: no webhook, no inbound ports, works behind any NAT.

## Web UI

- One-time login links (`amrita login-link`), session cookie for 30 days
- Streaming responses, collapsible tool chips, lanes for connector work
- Sidebar: Main, projects, sessions of the current context, Settings
- Mobile responsive; Hebrew/RTL safe (`dir="auto"` everywhere it matters)

## Terminal

`amrita chat` — same agent, same commands, ANSI streaming. `amrita chat --project <slug>` binds to a project.

## Adding a channel

A channel is one file implementing six methods (`src/shared/types.ts → ChannelAdapter`):

```ts
{ name, capabilities: {buttons, streaming, lanes},
  start(onMessage), stop(), send(chatId, message) }
```

Look at `src/channels/telegram/adapter.ts` (~150 lines, raw Bot API) as the reference; route inbound messages to `handleInbound()` and you inherit the entire command set, binding model, and agent loop.
