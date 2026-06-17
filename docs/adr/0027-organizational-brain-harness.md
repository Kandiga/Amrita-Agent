# ADR-0027: Organizational Brain Harness (engineered knowledge layer)

- **Status:** Accepted
- **Date:** 2026-06-17
- **Strategy:** `docs/strategy/organizational-brain-harness.md`
- **Supersedes-scope:** subsumes parity-roadmap **Phase G** (memory architecture) and frames
  **Phase H** (sources/connector registry) and **Phase F** (channels as sources).

## Context

"Organizational brain" must mean an **engineered agentic knowledge harness**, not generic RAG, not
an Obsidian-style graph visualization, and not a passive document vault. The product truths:

- **Retrieval is a tool, not the brain.** RAG answers a question from chunks; it does not *maintain*
  organizational knowledge.
- **Markdown + `[[links]]` is a good durable output format** — but the graph picture is not the
  product.
- **The harness is the brain:** a designed topology of agents that ingest, normalize, link,
  maintain, and evolve knowledge over time, with provenance and honest gaps.

Amrita already has the raw materials, event-sourced: project **brief**, **decisions** (append-only),
**open questions**, **risks**, **milestones**, **tasks** (with external provenance), **memory**
entries (with `source`), a derived **timeline**, **connectors** (GitHub), and a live **Telegram**
channel. What was missing was the *layer that treats these as one maintained knowledge graph* with
a typed record model, ingestion-source honesty, link/gap maintenance, and a harness topology.

## Decision

Add a **derived, typed harness layer** — no new store table this pass. The brain is a deterministic
**projection** over existing event-sourced state plus manually-captured memory, exactly like the
existing `surface.ts` artifact projection. This keeps the change honest and reversible, and defers a
dedicated `knowledge_records` table until real ingestion connectors justify persisted, normalized
records.

### 1. Protocol types (`@amrita/protocol` `harness.ts`)
- `knowledgeRecordSchema` — normalized record: `kind`
  (`decision | commitment | meeting-note | project-context | open-question | entity |
  source-excerpt`), `slug`, `title`, `body` (Markdown), `projectId`, `owner?`, `date?`,
  `confidence` (`low|medium|high`), `tags[]`, `links[]` (record slugs), `status`
  (`active|resolved|superseded|stale|contradicted`), and `provenance`
  (`sourceId`, `ref?`, `capturedAt?`, `channel?`).
- `knowledgeSourceSchema` — an ingestion source with an **honest** status
  (`connected | manual | planned`), `kind` (`manual|chat|email|calendar|docs|repo`), what it
  `extracts[]`, and a detail string. No source is `connected` unless it really ingests today.
- `knowledgeGapSchema` — `kind`
  (`missing-owner | missing-date | missing-source | orphan | unresolved-question | stale |
  contradiction`), `severity`, optional `recordSlug`, detail.
- `harnessTopologySchema` — `agents[]` of `{ id, role (ingest|link|maintain|answer), title,
  ingests?, maintains?, trigger, outputs[], qualityChecks[], status (active|planned) }`. This is
  the **harness-as-code** spec (typed config, not a new language).
- `projectBrainSchema` / `maintenanceEventSchema` — the assembled view returned to the UI.

### 2. Daemon harness layer (`@amrita/daemon` `harness.ts`)
- `HARNESS_TOPOLOGY` — the default agent topology, **honest** about what runs: a manual
  capture-agent, a linker, and a maintainer are `active` (they are implemented as the projection);
  email/calendar/chat-auto-extraction and a provenance-citing answer-agent are `planned`.
- `KNOWLEDGE_SOURCES` — base sources with honest statuses; the kernel enriches `chat` from the live
  Telegram runner and `repo` from the GitHub connector, but neither auto-*extracts* yet, so they
  stay `manual`/`planned` for ingestion with an exact note.
- `buildProjectBrain(input)` — a pure projection: maps brief/decisions/questions/risks/milestones/
  tasks/memory into `KnowledgeRecord`s **with provenance and `[[links]]`**, computes `KnowledgeGap`s
  (missing owner/date/source, orphans, unresolved questions, stale records, contradictions from
  superseded decisions / explicit markers), and derives a maintenance timeline from the event log.
- `renderRecordMarkdown(record)` — the durable Markdown output format.

### 3. Manual ingestion path
`harness.capture` writes a structured **memory** entry (existing store, `source: manual:brain`),
which the projection normalizes into a record with provenance. Real, persisted, no migration — the
manual capture-agent of the topology.

### 4. RPC + UI
- RPC: `harness.topology`, `harness.sources`, `harness.brain {projectId}`, `harness.capture`.
- Web: a **Brain** inspector view (tri-state Project/Brain/Settings) rendering ingestion lanes with
  honest status, records grouped by kind with provenance + links, a gaps list, the maintenance
  timeline, a manual-capture box, and an explainer distinguishing **RAG vs graph vs harness**.

## Consequences
- No protocol-persisted-row or store-schema change; the new schemas are **view/spec** contracts.
  (Per the constitution, adding protocol schemas is still ADR-gated — hence this ADR.)
- Secrets unaffected: records carry provenance *source ids and refs*, never secret values; manual
  capture goes through the existing value-free memory path.
- Existing Project Brain panels (brief/decisions/etc.) keep working; the Brain view is additive.

## Intentionally deferred (honest scope)
- A dedicated `knowledge_records` store table + `harness.*` persisted events — added when an
  automatic ingestion connector (email/calendar/chat extraction) lands and normalized records need
  to outlive their derivation. Until then the projection is the source of truth.
- Real email/calendar/Slack/Discord ingestion agents — `planned` with a manual-capture fallback.
- A provenance-citing "Ask Amrita from the maintained brain" answer-agent — `planned`; today's chat
  answers are not yet brain-cited, and the UI says so (retrieval ≠ maintained knowledge).
- Duplicate-merge and automated contradiction resolution beyond the simple superseded/marker cases.
