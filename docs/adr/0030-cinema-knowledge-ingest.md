# ADR-0030 — Cinema knowledge ingest (the first module extractor)

**Status:** Accepted · **Date:** 2026-07-02 · Builds on ADR-0027 (harness) + ADR-0028/0029 (cinema contract/mandates).

## Context
ADR-0027 deliberately shipped the Organizational Brain as a derived projection with `planned` ingestion sources, deferring real extraction until a source actually feeds data. The Cinema module now genuinely feeds the store: an idempotent production digest (`memory.put`, source `module:cinema`) and `[cinema]`-prefixed decisions for applied credit/destructive plans. That is a real ingestion source — time to honor it.

## Decision
1. `knowledgeSourceKindSchema` gains `'module'` (protocol 0.2.1).
2. `buildProjectBrain` (still pure, still projection-only — no new table):
   - memory entries with source `module:cinema` become **`project-context` records** with module provenance (`sourceId: 'module:cinema'`, ref `cinema-digest:<entryId>`), tags `['cinema','digest']`, stable slug per project (the digest entry is idempotent, so re-syncs update in place);
   - decisions whose text starts with `[cinema]` carry `sourceId: 'module:cinema'` and a `cinema` tag.
3. `cinemaKnowledgeSource(hasData)`: the source is **`connected` only when the given project actually holds cinema-synced memory** — otherwise `planned` with the exact next step. `harness.sources` gains an optional `projectId` for this per-project honesty; without one, the source renders `planned` (never a global fake green).
4. `HARNESS_TOPOLOGY` gains the `cinema-extractor` ingest agent with `status: 'active'` — active because this projection genuinely runs, unlike the still-`planned` email/calendar extractors.

## Consequences
- BrainPanel shows cinema records + the connected source with zero web changes (generic rendering over the same RPCs).
- The pattern is the template for future module extractors (Design Studio, Font Genesis): digest memory entry + prefixed decisions + `cinemaKnowledgeSource`-style honest gating.
