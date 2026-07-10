# ADR-0028 — Cinema module contract (MVP federation surface)

- Status: Accepted
- Date: 2026-07-02
- Amended: 2026-07-10
- Context owner: Amrita × Cinema integration (see the Cinema roadmap, Phase 1)

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
   - `cinemaDelegatedVerbSchema` — the **federation-delegated subset**: 17 action types + 8 video-op types. It is deliberately not a mirror of Cinema's larger local `VERB_REGISTRY`, which remains the local execution authority. Deprecated aliases remain for package compatibility, but must not be described as the full local whitelist.
2. **zod 3 → 4 upgrade** for `@amrita/protocol` and `@amrita/daemon` (`^4.4.3`). The full workspace suite stayed green; the only change needed was a test helper in `protocol/test/protocol.test.ts` that unwrapped zod-3 `ZodEffects` (zod 4 no longer wraps refined objects).
3. **Buildable protocol package, without touching workspace dev flow**: `tsconfig.build.json` (emits `dist/` ESM + `.d.ts`, `rewriteRelativeImportExtensions` for the repo's explicit-`.ts` imports), a `build` script, `files: [dist, src]`, and **`publishConfig`** overriding `main`/`types`/`exports` to `dist` **at pack time only** — workspace consumers keep resolving `./src/index.ts` exactly as before. External consumption is a packed tarball pinned inside the consumer repo (`pnpm --filter @amrita/protocol pack`); version bumped `0.0.0 → 0.1.0`. The package stays `private` (no registry publishing).

## Alternatives considered

- Merge Cinema into the Amrita monorepo: rejected because it risks the deployed product before federation value is proven.
- Use an untyped export facade: rejected because it creates a third contract dialect with no executable drift guard.
- Treat federation verbs as the full local registry: rejected in the 2026-07-10 amendment because federation delegates a deliberately smaller authority.

## Consequences

- Cinema's contract test parses the same digest fixture as `protocol/test/cinema.test.ts`, so drift between the repos fails a suite on either side.
- Digest ceiling matches the store's >32 KB artifact-spill threshold — a digest can always live inline in a memory entry.
- The delegated verb enum is a federation *subset*, not an executor and not Cinema's local capability registry. Cross-repo CI enforces `delegated ⊆ local`; it does not enforce equality. Audio-composer verbs remain local until a mandate use case earns a separate protocol/ADR change.
- Anything resembling a general `ModuleManifest` / `module.op.*` event plane remains out of scope until its own ADR, per the roadmap's YAGNI rule ("no module SDK before module #2").

## Fitness functions and evidence

- `packages/protocol/test/cinema.test.ts` validates the delegated vocabulary, digest bounds, media-byte exclusion, and plan-card contract.
- Cinema's `app/src/video/amritaContract.test.ts` validates every delegated verb against the local authorities and rejects audio-verb leakage into federation.
- `pnpm --filter @amrita/protocol build` proves the packed contract emits valid ESM and declarations.

## Rollout, rollback, and observability

Roll out by packing a versioned private tarball and updating the consumer's exact vendored dependency. Roll back by restoring the prior tarball and dependency lock. Contract parsing failures and subset drift fail CI; this ADR authorizes no provider call, deployment, data migration, or media egress.
