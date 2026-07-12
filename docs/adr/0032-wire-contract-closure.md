# ADR-0032 — Wire-contract closure: RPC results, WS frames, and shared enums live in the protocol

- **Status:** accepted (2026-07-11)
- **Context:** reorganization stage R0 — see `docs/AMRITA_ROOT_CAUSE_AUDIT.md` (findings
  A-1, A-2, A-3, A-4, B-1, B-2) and `docs/strategy/reorganization-master-plan.md` §7.

## Problem

The protocol was the constitution only up to the store. Beyond it:

1. **RPC results crossed the daemon→client boundary unparsed.** `apps/web/src/api.ts`
   hand-declared 28 `*Lite` interfaces and cast `body.result as T`; the daemon shipped raw
   kernel return values. No test bound the two.
2. **The protocol's WS contract was dead code.** `serverMessageSchema`/`clientMessageSchema`
   (ADR-0009 era) were used only by their own test, and the live transport emitted a
   `{t:'replayed'}` frame the schema didn't know. `apps/web/src/stream.ts` hand-redeclared
   the union and named `daemon/http.ts` as "authoritative" — overriding the constitution.
3. **Entity enums were module-private,** so the role list `['fast','main','deep']` was
   re-declared ~15× and task/auth/milestone enums 3× each (protocol / store / daemon-rpc /
   cli / web). `daemon/rpc.ts` imported nothing from `@amrita/protocol`.

## Decision

1. **`@amrita/protocol` owns the complete daemon↔client wire vocabulary.**
   `packages/protocol/src/rpc.ts` is rewritten to describe the REAL transport:
   - `rpcRequestSchema`, `rpcSuccessSchema`, `rpcErrorResponseSchema`, `rpcResponseSchema`,
     `rpcErrorCodeSchema` (moved from the daemon);
   - `wsServerFrameSchema` — the actual `/events/ws` frames: `{t:'event', event}` and
     `{t:'replayed', conversationId, sinceSeq}`;
   - **`rpcResultSchemas`** — a method-name → result-schema map covering EVERY RPC method.
     The daemon parses results through it on the way out (dispatch), the web client parses
     on the way in. Cinema module verbs are the one sanctioned opacity: their payloads are
     `z.unknown()` because the module daemon is their schema authority (AGENTS.md).
   - The ADR-0009 `clientMessageSchema`/`serverMessageSchema` are **removed** (they never
     matched the shipped transport; clients speak `POST /rpc`).
2. **Result parsing STRIPS undeclared keys** (zod object default). This is deliberate
   defense-in-depth: nothing undeclared can leave the daemon, ever — a new kernel field
   reaches clients only after it is declared in the protocol. A result that fails its
   schema is a daemon bug and maps to a value-free `internal` RPC error.
3. **Shared enums are exported from the protocol** and every inline copy is deleted:
   `PROVIDER_ROLES`/`providerRoleSchema`, `taskStatusSchema`, `memoryScopeSchema`,
   `authModeSchema`, `milestoneStatusSchema`, `questionStatusSchema`, `riskSeveritySchema`,
   `laneStatusSchema`, `connectorStatusSchema`, `providerConfigStatusSchema`,
   `runtimeViaSchema`, `approvalDecisionSchema`. The store re-exports these types instead
   of re-declaring them; Drizzle columns use `schema.options`.
4. **`packages/protocol/src/entities.ts` grows row schemas for every store row the wire
   carries** (task, decision, memory entry, brief, question, risk, milestone, brand,
   preview approval, connector, account, lane, conversation node, pairing).
5. **`apps/web` depends on `@amrita/protocol`.** All `*Lite` shapes become type aliases of
   protocol types (kept so components don't churn); `RpcClient.call` and the stream client
   parse everything through the protocol.
6. **Fitness functions** (tests):
   - every `METHODS` key in the daemon has a result schema and vice versa;
   - a kernel round-trip contract test dispatches every coverable method against real
     fixtures and fails on any schema mismatch;
   - web wrappers parse (no `as T` on unvalidated bodies).

## Consequences

- Protocol version 0.3.0 → **0.4.0** (additive + removal of the two dead ADR-0009 unions).
- A result-shape change now fails loudly in CI instead of silently breaking the web app.
- Adding an RPC method without declaring its result contract is impossible (coverage test).
- The web bundle gains zod via the protocol dependency — accepted; correctness wins.

## Rollback

Revert the protocol package to 0.3.0 and restore the daemon-local enums; the web aliases
keep compiling either way since they are structural aliases.
