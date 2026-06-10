# ADR-0012: Async provider runtime + real adapters

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** WO#2.3 kept the provider boundary synchronous because only the mock existed (ADR-0011
  flagged this). WO#2.4 makes the runtime async and implements real, env-backed provider adapters —
  with no real network call in tests and no secret in any output.

## Decision

### Async boundary, end to end
`ChatProvider.generate(req) → Promise<ChatResponse>`. The ripple:
- `kernel.runChatTurn` is `async` and `await`s `generate()` **outside any store transaction** (each
  `appendEvent` is its own sync transaction, before/after the single `await`).
- `dispatch` is `async` and `await`s the (possibly async) method handler.
- The stdio server serializes lines through a promise chain so responses stay in request order, and
  runs `onClose` only after the chain drains.
- The CLI is async: `InProcessClient.call`, the context resolvers, every command handler, and
  `run(argv, io) → Promise<number>`; the bin uses top-level `await`.

### Real adapters (`anthropic`, `openai`) with injectable fetch
Both adapters are implemented with **native `fetch`** (no new dependency) behind a small `FetchLike`
type, so tests inject a fake fetch and never hit the network. They map our transcript to the provider
wire format (`agent`→`assistant`; anthropic `system` is a top-level field) and map the response back
to `ChatResponse` (text, finish reason, token usage). On a non-2xx status or a fetch error they throw
`ProviderError('provider_error', …)` carrying **only a status/short message** — never headers, the
auth value, or a raw response dump.

### Env secret boundary
A real provider needs an account whose `secret_ref` (an env-var **NAME**, ADR-0008) is bound and
whose env var is present. `readEnvSecret(name)` is the **only** place a secret *value* is read, and
only to hand it to the adapter's auth header in the same call. The value never enters events, the DB,
RPC responses, CLI output, or logs. Structured, value-free errors: `missing_secret_ref`,
`missing_env_value`, `not_found` (no account/conversation), `provider_unavailable`, `provider_error`,
`unknown_provider`.

### Provider selection
- default / `provider=mock` → the deterministic mock.
- `provider=anthropic|openai` → needs an account. **Default account rule:** if no `accountId` is
  given, use the first account for that provider **with a bound `secret_ref`**; if none, a safe
  `not_found` ("no configured account") error.
- `accountId` given → that account is used; `provider` (if also given) must match the account's
  provider, else a safe error. `model` defaults per provider, overridable.
- `providers.list` reports, per provider, `available` / `configuredAccounts` / `envReady` — computed
  from account config + env **presence** (booleans only), exposing no value.

## On the assistant message / failure events
The turn still uses the existing taxonomy (no protocol change): a network/provider failure records a
`turn.failed { error }` (safe message) before the error propagates, so the log reflects the attempt.

## Deferred
Streaming tokens (`model.delta` to clients) and tool calling/MCP still change the turn's control flow
and front-end contract; they are deferred. Real adapters are not exercised against the network in CI.
