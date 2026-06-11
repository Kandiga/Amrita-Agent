# ADR-0016: stream-only delta bus (live `model.delta` from the daemon)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** D8 fixed `model.delta` as the only stream-only event type: emitted on the wire,
  never persisted (the store rejects it). The web client has rendered deltas as a draft assistant
  bubble since WO#4.2, but the daemon never emitted them — the Phase-4 acceptance ("streaming
  render of `model.delta`") was only half real. The WS live fan-out is driven by
  `store.subscribe`, a **post-commit** hook, which by construction can never carry an event the
  store refuses to persist.

## Decision

### A second, ephemeral fan-out path on the kernel
`AmritaKernel.subscribeStream(listener)` is a sibling of `store.subscribe` for stream-only events.
Deltas are sealed by the kernel itself with **`seq: 0`** (the store never assigns them a seq),
parsed by the protocol (`parseEvent`) before fan-out — nothing crosses a boundary unparsed — and
delivered only to live listeners. Listener errors are swallowed; a bad subscriber can never break
a turn. There is no replay: a client that connects mid-turn missed those deltas and simply waits
for the persisted `message.agent`.

`seq: 0` is deliberate: the envelope requires a nonnegative `seq`, real store seqs start at 1, and
the web reducer only advances its `lastSeq` cursor on larger values — so deltas can never corrupt
the replay cursor.

### Providers stream opt-in, honestly
`ChatProvider` gains an optional `generateStream(req, onDelta)` that must resolve with the same
final response `generate` would return. The kernel prefers it when present; the persisted record
(`model.response`, `model.usage`, `message.agent`) is built from the **final** response only, so
the event log is identical whether or not anyone was listening. The deterministic `mock` provider
streams its reply in word chunks whose concatenation equals the final text. The real
`anthropic`/`openai` adapters do **not** pretend to stream — they stay on `generate` until real
SSE adapters are built (a future, additive WO).

### The WS surface forwards both paths
`WS /events/ws` keeps its persisted-event subscription (with the `seq > lastSeq` cursor) and adds a
stream subscription that forwards `model.delta` frames for the connection's conversation as-is,
without touching the cursor. `GET /events` (replay) never returns deltas.

## Consequences
Chat now visibly streams in the web UI with the mock provider, the transcript event log is
byte-identical to the non-streaming world, and real-provider SSE streaming has a single seam to
implement (`generateStream` on the adapter) with no further kernel/transport/UI changes.
