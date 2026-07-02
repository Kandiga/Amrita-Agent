# ADR-0028 — Cinema module contract (MVP federation surface)

**Status:** Accepted · **Date:** 2026-07-02
**Context owner:** Amrita × Cinema integration (see `aba-adama-studio/docs/strategy/amrita-cinema-mvp-roadmap.md`, Phase 1).

## Context

Cinema Studio (repo `aba-adama-studio`, deployed at amrita-agent.tech) is becoming the first specialist module of the Amrita platform, by the **federated, facade-first** strategy: Cinema stays its own SPA/repo; the two systems speak through a typed contract owned here; `amritad` absorbs the module's brain verbs gradually. The alternative extremes were rejected in the planning package — a monorepo merge risks the only deployed product for zero early value; an untyped export facade rots into a third dialect.

Two mechanical facts shaped this ADR:
- The Cinema app pins `zod@^4.4.3` while this workspace pinned `^3.24.0`. A shared contract needs one zod.
- `@amrita/protocol` was workspace-only (`private`, raw-TS `exports`), so an external repo could not consume it at all.

## Decision

1. **New protocol namespace `cinema.ts`** with exactly four flat shapes — deliberately NOT a general module plane (that is a future ADR):
   - `cinemaProjectRefSchema` — links a Cinema project id (module-local string) to an Amrita project ULID.
   - `cinemaProjectDigestSchema` — a **metadata-only** project summary. The schema itself enforces the contract's load-bearing safety rule via refinements: serialized JSON < 32,768 bytes and **no media bytes** (`data:`/base64) anywhere. Media never crosses this contract.
   - `cinemaPlanCardSchema` — mirrors Cinema's shipping `AgentPlan` 1:1 (6 kinds, 4 risk tiers, Apply/Discard lifecycle). We standardize what exists; we do not redesign it here.
   - `cinemaVerbSchema` — the module's whitelisted vocabulary: 17 action types + 8 video-op types, copied verbatim from the module's own server whitelist (`brain-bridge/cinema-agent.mjs`), which remains the single source of truth.
2. **zod 3 → 4 upgrade** for `@amrita/protocol` and `@amrita/daemon` (`^4.4.3`). The full workspace suite stayed green; the only change needed was a test helper in `protocol/test/protocol.test.ts` that unwrapped zod-3 `ZodEffects` (zod 4 no longer wraps refined objects).
3. **Buildable protocol package, without touching workspace dev flow**: `tsconfig.build.json` (emits `dist/` ESM + `.d.ts`, `rewriteRelativeImportExtensions` for the repo's explicit-`.ts` imports), a `build` script, `files: [dist, src]`, and **`publishConfig`** overriding `main`/`types`/`exports` to `dist` **at pack time only** — workspace consumers keep resolving `./src/index.ts` exactly as before. External consumption is a packed tarball pinned inside the consumer repo (`pnpm --filter @amrita/protocol pack`); version bumped `0.0.0 → 0.1.0`. The package stays `private` (no registry publishing).

## Consequences

- Cinema's contract test parses the same digest fixture as `protocol/test/cinema.test.ts`, so drift between the repos fails a suite on either side.
- Digest ceiling matches the store's >32 KB artifact-spill threshold — a digest can always live inline in a memory entry.
- The verb enum is a *vocabulary*, not an executor: registering executable `cinema.*` RPC methods is Phase-2 work and does not require a protocol change beyond this namespace.
- Anything resembling a general `ModuleManifest` / `module.op.*` event plane remains out of scope until its own ADR, per the roadmap's YAGNI rule ("no module SDK before module #2").
