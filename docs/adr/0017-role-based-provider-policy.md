# ADR-0017: role-based provider policy (fast / main / deep / auto)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** D1/D5 planned role-based providers from day one: a turn asks for a *role*
  (`fast` for cheap/quick work, `main` for the default assistant, `deep` for hard reasoning) and a
  policy maps roles to concrete provider+model, with `auto` resolving at runtime. Until now every
  turn named a concrete provider (default `mock`). The provider boundary (ADR-0011/0012), the
  settings table (non-secret, tripwired), and `providers.list` availability give the policy all
  the seams it needs — no store or protocol change required (the `model.request` event already
  carries `role`).

## Decision

### Roles are a resolution layer, not a new provider kind
`chat.turn` accepts an optional `role: 'fast'|'main'|'deep'`. Resolution order, strictly:

1. **Explicit `provider` (or `accountId`) always wins.** Existing flows are untouched; `role`
   then only labels the turn.
2. **Settings binding** — `providers.role.<role>` holds `{provider, model?}` in the existing
   `settings` table (values are non-secret by construction; the table's secret-key tripwire and
   the key shape both hold). An explicit `model` on the turn overrides the binding's model.
3. **`auto`** — the first *available* real provider (bound account + env var present), else the
   deterministic `mock`. Auto never selects a configured-but-broken provider: availability is the
   same boolean `providers.list` reports.

The resolved role is recorded on the persisted `model.request` event (previously hardcoded
`main`) and returned on the turn result, so transcripts show *why* a provider was chosen.

### Surfaces
- RPC: `chat.turn {role?}`, `providers.roles` → per-role `{binding|null, resolvesTo, via}`.
- CLI: `amrita role list|set|clear`, `amrita chat --role`.
- Doctor: a `role policy` check in ◆ providers — **unconfigured auto is a warning** (PLAN §5.4)
  with the exact `amrita role set …` fix; bindings render as `main → anthropic · …`.

### Malformed bindings fail soft
A binding that doesn't parse (`parseRoleBinding`) is treated as absent → auto. A typo in settings
can degrade a role to auto but can never crash a turn or silently pin a broken provider.

## Consequences
Channels (web/Telegram/CLI) can speak in intents ("use the deep model") without knowing the
provider catalog; swapping the default model becomes one settings write; and the Companion work
can route background/summary turns to `fast` without touching call sites. Per-project role
overrides (key-prefixing by project) and a `role` column in usage reporting are additive
follow-ups.
