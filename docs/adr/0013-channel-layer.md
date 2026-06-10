# ADR-0013: Channel layer (web + Telegram owner-gate skeleton)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** Phase 3 adds channels — surfaces (web, Telegram, …) that turn inbound messages into
  Amrita chat turns. This WO builds the foundation: a `Channel` contract, a web adapter, and a
  Telegram skeleton with owner-only gating and pairing — **with no real Telegram network in tests**.

## Decision

### Channel contract (`@amrita/channels`)
A channel normalizes an `InboundUpdate {kind, userId, chatId, text}`, runs the kernel chat-turn path,
and returns a `ChannelResult {channel, handled, outcome, conversationId?, replies, error?}`. Channels
go through the kernel/Store API; outputs carry no secret.

### Web channel
`WebChannel` is a thin adapter: context is explicit (the client supplies `conversationId`), it runs
`kernel.runChatTurn`, and returns the reply. Web auth/sessions are deferred.

### Telegram channel — owner-gated, pairing-linked
- **Deny-by-default** numeric allowlist; the gate applies to **both** messages and callback queries.
  Denied updates send nothing and are dropped (the numeric id is recorded for diagnostics — never any
  content).
- **Pairing:** an admin creates a code for a project+conversation; an allowed owner sends `/pair CODE`
  to link their Telegram identity to that context. Subsequent messages run chat turns in the linked
  conversation; replies are **chunked** to Telegram's ~4096-char limit, sent in order.
- The bot **token lives in env/config only** — never in the channel object, the DB, events, or any
  output. The real bot transport (long-poll/webhook) is injected as a `sender`/fake in tests and
  implemented in a later WO.

### Pairing persistence (migration `0003`, DIRECT write)
`channel_pairings(code PK, channel, project_id, conversation_id?, claimed_by?, created_at,
claimed_at?)` links an external identity to a context. Like `account.secret_ref` (ADR-0008) this is
local linking **configuration**, written directly (not event-sourced). `code` is a low-sensitivity
pairing token — **never** an API key or bot token, and it does not match a secret-shaped pattern.
Store API: `createPairing` / `consumePairing` (rejects unknown / already-claimed) / `getChannelLink` /
`listPairings`. RPC: `channels.list`, `channels.pairing.create`, `channels.pairing.list`. CLI:
`amrita channel list | pair | pairings`.

## Secret-safety
No token or secret value enters the channel object, the DB, events, RPC responses, CLI output, or any
reply. Provider/runtime errors surface as safe messages (no stack). The Telegram allowlist is the
owner gate; pairing is the linking mechanism.

## Deferred
The real Telegram bot transport (grammY/long-poll), web sessions/auth, callback-button pairing flows,
and multi-conversation routing per Telegram chat are later WOs.
