# ADR-0011: Chat turn runtime + provider boundary (mock-first)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#2.3 adds the first chat turn path so every front-end (CLI, later web/Telegram) shares
  one kernel route. It must be testable with **no external API calls** and leak **no secret**.

## Decision

### No new protocol — the turn uses the existing taxonomy
A chat turn emits, all through `appendEvent` (atomic + projected), in order:
`message.user` → `turn.started` → `model.request` → *(provider call)* → `model.response` →
`model.usage` → `message.agent` → `turn.completed`, sharing one `turnId` on the envelope. The
**assistant message is a `message.agent`** (role `agent` in `messages`, FTS-searchable) — *not* an
overload of `message.user`, and no new event type was needed. Provider metadata lives in `model.*`
(provider name, model name, token counts) — never a secret value. `model.delta` stays stream-only.

### Provider boundary (`provider.ts`)
`ChatProvider.generate(req) → ChatResponse` turns a transcript into one reply. A `ProviderRegistry`
exposes a deterministic **`mock`** provider (always available) and **scaffold** entries
(`anthropic`, `openai`) that are listed for discovery but **never runnable in this WO** (`available:
false`). `resolveChat(id)` throws a structured `ProviderError` for scaffold/unknown ids, so tests
never make a network call. Env is checked **presence-only** (`envPresent` → boolean); a value is
never read, returned, or logged.

### `kernel.runChatTurn`
Records the user message, resolves the provider (default `mock`), invokes `generate()` **outside any
store transaction** (a pure side effect), then persists the assistant message + turn/model events.
Returns a secret-free result (`turnId`, provider, model, text, usage, message ids/events). `dryRun`
records the user message and stops before the provider call. Requesting an `accountId` or a real
provider returns a **safe structured error** (`provider_unavailable` / `not_found`) — no secret read.

### RPC / CLI
`chat.turn` and `providers.list` RPC methods (zod-validated; `ProviderError` maps to a
`provider_unavailable` RPC code). CLI: `amrita chat <TEXT>` (prints the assistant reply + a metadata
line, or `--json`) and `amrita provider list`. The CLI reuses WO#2.2's default-conversation context.

## Synchronous, for now
`generate()` is **synchronous** because the only implementation (mock) is. This keeps `dispatch`, the
CLI, and the turn path synchronous (no async ripple). Real HTTP adapters are async; integrating them
is a future WO that will make `runChatTurn` + `dispatch` + the CLI async. Building that async plumbing
now — for adapters that don't exist and aren't called — would be speculative; it is deferred.

## Why streaming / tools are deferred
Streaming (`model.delta` to clients) and tool calling/execution change the turn's control flow and the
front-end contract; they layer on top of this stable non-streaming turn in later WOs.

## Secret-safety guarantees
No secret value enters events, the DB, RPC responses, CLI output, or logs. Provider config is
presence-only; `account` binding remains the secure env-NAME path (ADR-0008). Requesting an
unconfigured/real provider fails with a structured, value-free error.
