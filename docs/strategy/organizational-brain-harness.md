# Organizational Brain Harness — strategy

Amrita's "organizational brain" is an **engineered agentic knowledge harness**. This doc states what
that means, what it is *not*, and how it maps onto Amrita's existing event-sourced architecture.
Implementation decisions are in [ADR-0027](../adr/0027-organizational-brain-harness.md).

## The product truth (what the brain is, and is not)

| | What it is | What it is **not** |
|---|---|---|
| **RAG / retrieval** | a *tool* the harness can call to fetch relevant chunks at answer time | the brain. Retrieval doesn't normalize, link, or maintain anything over time. |
| **Graph view / `[[links]]`** | a good *durable output format* and an optional visualization | the product. A pretty graph over un-maintained notes is a vault, not a brain. |
| **The harness** | a designed **topology of agents** that ingest → normalize → link → maintain → evolve organizational knowledge, with provenance and honest gaps | a passive document store; a one-shot import; a vector-search demo. |

Knowledge lives in mail, calendar, chats, meetings, docs, decisions, promises, project context, and
people's heads. The harness makes that **operational**: it turns scattered signal into normalized,
linked, owned, dated, sourced records — and it keeps surfacing what's missing.

## The five concepts

1. **Sources / ingestion agents** — email threads, calendar/meetings, chat (Telegram/Slack/Discord),
   docs/files/repos, and manual capture ("remember this for the project brain"). Each source has an
   **honest status**: `connected` (really ingests today), `manual` (you import/capture by hand), or
   `planned` (designed, not built). No fake green.
2. **Knowledge records** — normalized Markdown records, not random dumps:
   `decision · commitment/promise · meeting-note · project-context · open-question · entity ·
   source-excerpt`. Each carries metadata: **source/provenance, date, confidence, owner, project,
   tags, links, status**.
3. **Linking & coherence agents** — create `[[links]]`, merge duplicates carefully, **mark
   contradictions instead of hiding them**, and surface stale knowledge, orphan records, and missing
   owner/date/source. Maintain a coherent **Project Brain** and (later) **Org Brain** over time.
4. **Harness-as-code / topology** — a typed spec (`harnessTopologySchema`): which agent ingests what,
   which maintains which layer, what triggers each loop, what outputs it produces, and what quality
   checks must pass. Config, not a new language (yet).
5. **Product expression** — a premium Project OS Brain view: ingestion lanes with honest status,
   records with provenance and links, a gaps list, a maintenance timeline ("what agents
   extracted/linked/flagged and why"), and an HTML brain rendered inside Amrita. "Ask Amrita" will
   answer from the maintained brain *with citations*, and will distinguish retrieval from maintained
   knowledge.

## How it maps onto today's Amrita (no duplication)

The brain is a **derived projection** over what Amrita already stores event-sourced — the same
pattern as `surface.ts`. Nothing is re-stored:

| Harness concept | Built from (today) | Status |
|---|---|---|
| project-context record | project **brief**, **milestones** | active (derived) |
| decision record | append-only **decisions** (+ `supersedes`) | active (derived) |
| open-question / gap | **open questions**, **risks** | active (derived) |
| commitment / meeting-note / entity | **memory** entries via manual capture (`source: manual:brain`) | active (manual) |
| source-excerpt | memory entries with external `source` | active (manual) |
| links | decision↔question (`resolvedByDecisionId`), task↔milestone, brief↔milestones, shared tags | active (derived) |
| gaps | missing owner/date/source, orphans, unresolved questions, stale, contradictions | active (derived) |
| maintenance timeline | the project **event log** | active (derived) |
| chat source | live **Telegram** runner | connected transport, **planned** extraction |
| repo source | **GitHub** connector / issue import | **manual** ingestion |
| email/calendar/docs sources | — | **planned** |
| answer-agent (brain-cited) | chat turns | **planned** (today's answers are not brain-cited) |

## Migration path (honest, staged)

- **Now (ADR-0027):** typed harness contracts + derived projection + manual capture + Brain view.
  The projection *is* the source of truth; records are recomputed, not persisted.
- **When the first automatic ingestion connector lands** (email/calendar/chat extraction): add a
  dedicated `knowledge_records` store table + `harness.*` persisted events (new ADR + reversible
  migration), so normalized records outlive their derivation and carry independent provenance.
- **Later:** duplicate-merge, contradiction resolution workflows, Org-level brain across projects,
  and the provenance-citing answer-agent.

## Non-negotiables (carried from Amrita's identity)

- Honest integrations only — `connected` requires real ingestion; otherwise `manual`/`planned` with
  the exact next step.
- Secrets never enter records, provenance, logs, or the UI — provenance is source ids/refs only.
- Chat-first Project OS direction preserved; the Brain view is additive, not a replacement.
- Not a generic RAG feature; retrieval, when added, is labeled as a tool and kept distinct from
  maintained knowledge.
