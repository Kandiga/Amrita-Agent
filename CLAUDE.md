# Amrita v2 — working agreement

Amrita is a chat-first, project-aware, multi-channel agent OS. This is the **greenfield v2**
rebuild as a typed pnpm monorepo. v0.1 (the single-package zero-dependency implementation) lives
in a separate repo and is frozen at tag `v0.1`; treat it as a *reference implementation*, not a
copy-paste source. See `docs/v01-harvest.md` for what to mine from it and what to leave behind.

## Non-negotiables

1. **Schema-first.** Every event, RPC message, and persisted row is a Zod schema in
   `@amrita/protocol`. Nothing crosses a boundary (channel ↔ daemon ↔ store ↔ lane) without being
   parsed by a schema. The protocol package is the **constitution**.
2. **No `any`.** `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are on.
   Biome flags `noExplicitAny` as an error. Model unknowns as `unknown` and narrow.
3. **The protocol and the store schema change only via an ADR.** Add a numbered file under
   `docs/adr/`, get it approved, then change code. Migrations are append-only and reversible.
4. **Tests live with the package.** Every package has a `test/` dir run by Vitest. New behaviour
   ships with a test in the same change.
5. **Conventional commits.** `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
6. **Honest integrations only.** Never fake an auth path or a capability. Unconfigured surfaces say
   "needs setup". (Carried forward from v0.1 — it is the project's identity.)

## Layout

```
packages/
  protocol/   Zod event protocol, lane contract, RPC, entity row schemas — the constitution
  store/      Drizzle + better-sqlite3 event store, migrations, FTS5 search
  lanes/*     (later) per-lane runners (claude-code, …)
docs/
  PLAN.md                 the v1.0 architecture & build plan
  specs/                  detailed specs for the protocol and the store
  adr/                    architecture decision records (headline + open-question defaults)
  v01-harvest.md          v0.1 → v2 mapping: what to reuse, what not to carry over
```

## Commands

```bash
pnpm install
pnpm typecheck   # tsc --noEmit across the workspace
pnpm test        # vitest run
pnpm lint        # biome check
```

## Identifiers

ULIDs everywhere (`@amrita/protocol` `newId()`), never auto-increment integers in the domain.
Events carry a per-conversation monotonic `seq` (assigned by the store inside the append
transaction) for total ordering within a conversation.
