# ADR-0031 — Video-grounded audio contracts and Phase 0 authority

- Status: Accepted
- Date: 2026-07-10
- Scope: `@amrita/protocol` contract ownership plus the Cinema implementation in the sibling `aba-adama-studio` repository

## Context

Cinema needs a video-grounded music and sound-effects workflow without widening federation authority, duplicating project writers, leaking media bytes, or sending paid provider requests before durable reservation. The existing 17 action plus 8 video-operation contract had also drifted semantically: it was documented as the complete local Cinema whitelist although the local registry had grown beyond it.

## Decision

1. `packages/protocol/src/cinema.ts` owns only `CINEMA_DELEGATED_ACTION_TYPES` and `CINEMA_DELEGATED_VIDEO_OP_TYPES`. The invariant is `delegated ⊆ local`; the local registry remains authoritative inside Cinema.
2. `packages/protocol/src/cinema-audio.ts` owns the shared app-to-bridge metadata contracts: `VideoAnalysisRecord`, `AudioCuePlan`, `AudioGenerationJob`, `AudioCandidate`, `TimelinePatch`, and `GenerationReceipt`.
3. These audio records are not federation payloads. `cinemaProjectDigestSchema` remains metadata-only, bounded, and media-byte-free.
4. The sibling Cinema repository keeps one canonical project writer in `brain-bridge/project-store.mjs`, reached through `project-executor.mjs`. Browser stores are projections and caches.
5. Provider and media-residency decisions are server-owned in `audio-provider-policy.mjs` and `media-residency-policy.mjs`; UI components may not duplicate or bypass them.
6. Paid jobs use the existing `job-store.mjs` interface, extended with synchronous fail-closed reserve-before-send and provider-handle persistence. A second paid-job API is forbidden.
7. Conservative defaults apply until the owner changes them explicitly: EU-facing compliance assumptions, full external-provider blocking in confidential mode, no silent fallback, SFX candidate count one, and music candidate count two.
8. Audio verbs do not enter the federation subset without a separate mandate use case and ADR.

## Alternatives considered

- Treat the 17 plus 8 contract as the complete local whitelist: rejected because it turns federation drift into local authority drift.
- Put detailed media records into federation digests: rejected because the digest must remain bounded metadata with no media bytes.
- Create a second audio job store: rejected because it would split billing/idempotency authority.
- Move immediately to SQLite/WAL: deferred because a single-process, file-backed interface can satisfy the first durability gates with synchronous atomic writes; SQLite becomes mandatory if chaos or concurrency tests fail.
- Allow confidential projects to use external providers opportunistically: rejected because silent egress is an unacceptable default.

## Consequences

- Existing aliases remain temporarily for source compatibility but are deprecated; new code uses delegated names.
- Protocol version advances to `0.3.0` and Cinema consumes the built vendored package.
- Provider prices remain dynamic adapter estimates and receipts; they are not constants in the policy registry.
- `submitting` without a provider handle is an ambiguous state requiring reconciliation, never proof that no provider request happened.
- Feature implementation remains blocked until the Phase 0 fitness functions pass.

## Fitness functions and evidence

- Protocol tests prove the delegated vocabulary and schema strictness.
- Cinema's cross-repository test proves every delegated verb exists locally and audio verbs remain absent.
- Job-store tests prove synchronous reservation, fail-closed disk errors, corruption blocking, explicit paid retention, durable provider handles, and abrupt-process recovery.
- Provider/media tests prove confidential egress blocking, no fallback, range-proxy-only approved egress, and production blocking for prototypes or known rights/territory failures.
- Existing digest tests prove size bounds and media-byte exclusion.

## Rollout, rollback, and observability

Roll out Phase 0 as contracts, policies, ADRs, and tests only. Do not deploy, migrate data, call providers, or spend credits. Rollback is deletion of the new package export/policies plus restoration of the previous vendored protocol; no persisted product data is changed. Future generation jobs must emit structured reservation, submission, reconciliation, cost, privacy, and receipt events before production enablement.
