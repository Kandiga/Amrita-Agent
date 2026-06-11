# ADR-0019: runtime selection, Settings & Runtime Hub, and memory/session invariance

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** §2.8/§2.9 of docs/strategy/native-interactive-surface.md fixed the direction:
  Amrita's brain model and her execution runtimes are independently selectable, no connector
  gets a vendor-special path, and Amrita's memory is owned by the project store — never by a
  provider. ADR-0017 shipped global role bindings; the previous phase added the project scope.
  This ADR turns that into the full contract the Settings & Runtime Hub, the CLI, and every
  future connector build against.

## Decision

### 1. Provider/runtime categories (one contract, no vendor specials)
`api-key/BYOK provider` · `account-auth/subscription connector` · `local runtime` ·
`hermes bridge/adapter` (discovery-based, future) · `coding-agent bridge` · `tool/MCP connector`
(future, own ADR) · `manual/offline runtime`. Every category reports through the same typed
status surface; none gets bespoke UI logic.

### 2. Runtime roles
Today's implemented roles are the brain tiers `fast | main | deep` (ADR-0017). The contract
reserves named roles for `planning`, `coding`, `review`, `qa`, `research`, `design`, `browser` —
they join the same resolver as additive role names; the coding role is fulfilled by lane
bridges (`lanes.start {kind}`), not by chat-provider bindings. Until a reserved role is
implemented it is presented as *planned*, never as a working selector.

### 3. Scope resolution (deterministic, one resolver)
```
session/turn override > lane/task override > project override > global default > auto
```
Implemented today: turn override (`chat.turn {provider|model|role}`), project binding
(`project.<projectId>.providers.role.<role>` in settings), global binding
(`providers.role.<role>`), `auto` (first *available* real provider, else the deterministic
mock). Lane/task scope is an additive settings key on the same `resolveRole` resolver — no new
mechanism. `auto` never selects a configured-but-broken provider.

### 4. Memory/session invariance (the correctness bar)
- Project memory, conversations, briefs, questions, risks, milestones, tasks, decisions, and
  the timeline belong to **Amrita's event-sourced store**, keyed by project/conversation ids —
  never by provider identity.
- **Switching the brain provider/model (any scope) creates no new project or conversation,
  erases nothing, and forks nothing.** The next turn simply resolves differently.
- Every turn records **runtime provenance** on its persisted `model.request` event:
  `{provider, model, role, via}`, where `via ∈ explicit | project | binding | auto | default`
  (the new optional `via` field — this ADR's protocol change). Old events without `via` parse
  unchanged.
- Provider-side hidden state is never required for continuity: context is always rebuilt from
  the typed store (`listMessages`). If a future connector keeps an external thread id, it is
  stored as connector metadata/provenance only, and if its hidden context is lost on switch,
  Amrita reconstructs from the store and says so honestly.
- These invariants are enforced by the daemon test suite (`invariance.test.ts`): same
  conversation across a provider/model switch, history monotonically grows, companion state
  intact, per-turn provenance preserved, project overrides isolated per project, clears fall
  back without deleting anything.

### 5. Brain ⊥ execution independence
The brain can be any chat provider while Claude Code (or a future bridge) does the coding —
and vice versa. Concretely: coding-runtime status (`runtime.status.codingRuntimes`) is probed
and displayed regardless of role bindings, and lane starts never read the brain bindings.
Claude Code's card is one runtime card among peers, not the center of the product.

### 6. Coding-runtime probing (honest, bounded)
`packages/daemon/src/runtimes.ts`: `claude --version` then `claude auth status`, each behind a
1.5 s timeout, no shell, output capped and **classified, never echoed**. States:
`ready | installed_unauthenticated | installed_auth_unknown | not_installed | status_unknown`,
each with an exact next command where known. An inconclusive probe is `status_unknown` — never
a green badge. The prober is injectable (`KernelOptions.codingRuntimeProber`); tests never
spawn real CLIs.

### 7. Settings surface
- RPC: `runtime.status {projectId?}` (roles + providers + coding runtimes in one read),
  `providers.role.set {role, provider, model?, projectId?}` (provider validated against the
  catalog, project validated to exist), `providers.role.clear {role, projectId?}`. Writes go
  through the system project's `(default)` conversation envelope (the CLI's existing
  convention, now mirrored in the kernel as `systemWriteContext`).
- CLI: `amrita runtime status [--project]`, `role set/clear` now call the RPC methods (no more
  raw settings keys in the CLI — one write path).
- Web: the Settings & Runtime Hub renders this aggregate with the honest status vocabulary;
  future-only categories are labeled *future/manual-required*, never green.

### 8. Connector policy (product rules)
Official/allowed routes only, per provider. For Claude subscriptions specifically: Claude Code
local runtime and Claude Agent SDK / `claude -p` where officially permitted — **never** an
unofficial "Claude Max API", never OAuth/cookie scraping, never shared pooled credentials. API
providers use API keys via env-name refs (ADR-0003/0008). Account-auth connectors are per-user
and local. Secrets never reach the frontend, events, artifacts, logs, tests, or handoffs.

## Consequences
The Hub, CLI, and all future connectors consume one typed contract; provenance makes "which
model said this?" answerable forever from the log; and the invariance suite turns "switching
models must not break memory" from a promise into a regression test.
