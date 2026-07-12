# ADR-0037 — WhatsApp channel adapter, shared channel handler, and the operator RPC verb

- **Status:** accepted (2026-07-12)
- **Context:** reorganization stage R6 (`docs/strategy/reorganization-master-plan.md` §5);
  R2 already moved operator-command interpretation into the kernel so a new channel
  cannot re-implement it.

## Decision

1. **`whatsapp` joins the protocol's channel enum** (additive — old events replay
   unchanged). The store's Drizzle column derives from the same schema (ADR-0032
   `columnEnum`), so there is exactly one place the channel list lives.
2. **The chat-channel flow is extracted to ONE shared handler**
   (`channels/src/base.ts` `runChannelUpdate`): owner gate → `/pair CODE` →
   kernel session resolution (R2, one brain) → operator commands (R2 kernel service)
   → chat turn → chunked replies. Telegram now delegates to it; WhatsApp uses it with
   a string-id allowlist. No channel duplicates a single decision.
3. **`WhatsAppChannel`** (official Cloud API surface only — honest-integrations rule):
   deny-by-default allowlist of WhatsApp user ids, injected `WhatsAppSender`.
   **The live webhook runner is NOT bundled yet** — WhatsApp Cloud is webhook-push (an
   HTTPS endpoint + verify token), which is a deployment surface of its own. The
   adapter + contract tests ship now; `channels.list` reports whatsapp as
   `needs_setup` with the exact env NAMES (`WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`) and states the runner gap.
   Nothing is faked.
4. **`operator.command` RPC verb** `{ projectId, text } → { reply }` — terminal parity:
   `amrita op '<command>' --project <p>` answers EXACTLY what Telegram/WhatsApp answer,
   because all of them call the same kernel service.
5. **Fitness function:** a two-channel memory test runs the same conversation through
   the Telegram adapter and a `web` chat turn and asserts ONE conversation carries all
   messages with per-channel provenance — the no-memory-duplication guarantee is now
   executable.

## Store change

`events.channel` had a SQL CHECK (`web/telegram/cli/api`), so this ADR ships migration
**`0007_whatsapp_channel`**: the events table is rebuilt with the widened CHECK (data,
uniqueness, and indexes preserved). The down migration restores the old CHECK and
refuses — by CHECK violation — if whatsapp events already exist: reversible only when
no data would be silently invalidated.

## Rollback

Migration 0007 down (see above) + revert: enum value, shared handler module, adapter,
RPC verb + schema.
