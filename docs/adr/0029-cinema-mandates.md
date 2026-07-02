# ADR-0029 — Cinema mandates: Amrita → module delegation

**Status:** Accepted · **Date:** 2026-07-02 · Builds on ADR-0028.

## Context
The platform story requires the main Amrita brain to DELEGATE work to the Cinema module ("make a teaser for this project") while the module keeps its own trust model. The architecture doc sketches a generic ModuleMandate mirroring LaneMandate; the roadmap's YAGNI rule forbids a module SDK before module #2 exists.

## Decision
1. **Cinema-scoped mandate types in `cinema.ts`** (not a generic module plane): `cinemaMandateSchema` — `{mandateId, goal ≤2000, allowedVerbs? (subset of the module vocabulary), maxRisk (default 'credit'), note?, issuedAt}`; `cinemaMandateReportSchema` — `{mandateId, exit done|partial|refused|aborted, summary, opsApplied[], plansApplied[], refusedReason?}`. Generalization is deferred to module #2 by design.
2. **Two event payloads** in the closed set: `module.mandate.issued` / `module.mandate.resolved` (each `{moduleId, mandate|report}`). No progress events — module-local progress stays module-local; the log records intent and outcome only.
3. **Execution model = the module's existing trust ladder.** `maxRisk` is the ceiling for AUTO execution; anything above it surfaces as the module's plan card, and a human Apply IN the module is the upward approval. amritad never drives the module's UI; the module (browser) polls open mandates over the authenticated RPC and reports back.
4. **RPCs**: `cinema.mandate.issue` / `cinema.mandate.list` (derived open/resolved projection over the conversation's events — no new table, per ADR-0027 discipline) / `cinema.mandate.complete` (idempotence: completing a non-open mandate returns `{ok:false, reason}` rather than erroring).

## Consequences
- Mandates live in the project's "Cinema sync" conversation, so `projects.timeline.list` and the event stream already carry them with zero web changes.
- A future module plane can lift these shapes verbatim (they mirror LaneMandate/MergeReport in spirit) — the migration path is rename + widen, not redesign.
