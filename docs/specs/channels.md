# Spec: the channel layer

`@amrita/channels` (Phase 3) turns inbound messages from a surface into Amrita chat turns. See
[ADR-0013](../adr/0013-channel-layer.md). **No real Telegram network call happens in this package** —
the outbound surface is injected.

## Contract (`types.ts`)

- `InboundUpdate { kind: 'message'|'callback', userId, chatId, text }` — a normalized update.
- `ChannelResult { channel, handled, outcome, conversationId?, replies, error? }` where `outcome ∈
  {denied, unpaired, paired, replied, error}`.
- `chunkText(text, maxLen)` — ordered ≤maxLen chunks (rejoin == input).
- `safeMessage(e)` — a value-free error string (no stack).

## Web channel (`WebChannel`)

`new WebChannel(kernel).handle({conversationId, text, provider?, model?})` runs `kernel.runChatTurn`
and returns the reply as `replies`. Context is explicit; web auth is deferred.

## Telegram channel (`TelegramChannel`)

`new TelegramChannel(kernel, sender, { allowedUserIds, chunkSize? })`, `handleUpdate(update)`:

1. **Owner gate (deny-by-default).** If `Number(userId)` is not in `allowedUserIds`, the update is
   dropped (`outcome:'denied'`, nothing sent) — for **both** messages and callbacks. The id is pushed
   to `droppedUserIds` (diagnostics; no content).
2. **`/pair CODE`** → `consumePairing` links this identity to the code's project+conversation
   (`outcome:'paired'`); unknown/claimed codes return a safe `error`.
3. Otherwise, if linked → run a chat turn in the linked conversation and **chunk** the reply to
   `chunkSize` (default 4000), sent in order (`outcome:'replied'`); if not linked → prompt to pair
   (`outcome:'unpaired'`).

The bot token is **never** held here — it belongs in env/config and is wired to a real transport in a
later WO. `sender: { sendMessage(chatId, text) }` is injected (a fake in tests).

## Pairing admin

- RPC: `channels.list`, `channels.pairing.create {channel?, projectId, conversationId?}` → `{code}`,
  `channels.pairing.list {channel?}`.
- CLI: `amrita channel list`, `amrita channel pair --project <ID_OR_SLUG> [--conversation ID]
  [--channel telegram]` (prints the code), `amrita channel pairings [--channel telegram]`.

Pairing data lives in `channel_pairings` (migration `0003`), a direct-write config table holding **no
secrets** (the `code` is a low-sensitivity pairing token).

## Not implemented yet

Real Telegram transport (long-poll/webhook), web sessions/auth, callback-button pairing UX, streaming,
and tool/lane execution are deferred.
