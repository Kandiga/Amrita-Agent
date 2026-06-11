# Amrita as a Project Companion — research, strategy, and roadmap

- **Date:** 2026-06-11
- **Status:** Proposed (strategy artifact; implementation phases gated by their own ADRs)
- **Inputs:** the live codebase (protocol/store/daemon/cli/channels/web as of `ea714c2`),
  docs/PLAN.md, ADR-0001…0017, docs/hermes-architecture-notes.md, docs/v01-harvest.md, and a web
  research pass over the June-2026 agent/MCP/PM-tool ecosystem (sources at the end).

Amrita's identity is already decided: *conversation is the interface, projects are the unit of
memory, connectors not shells, honest integrations only.* This document answers the next
question: **what does it take for Amrita to genuinely accompany a project from idea to release**,
and in what order to build it.

---

## 1. What "accompanying a project" means

A project companion is not a chat with history. It is a system that holds the project's state of
truth *between* conversations and pushes the project forward at every touch. Concretely, across
the lifecycle:

| Lifecycle stage | What Amrita must do | What exists today | Gap |
|---|---|---|---|
| **Intake / brief** | Turn a first conversation into a structured brief: goal, audience, constraints, success criteria | `projects` table (slug/name/root), free-text chat | A typed **brief** (goal + success criteria) on the project; an intake flow that fills it from conversation |
| **Goals & success criteria** | Hold 1–3 explicit goals; every plan and task traces to one | — | `goal` entity (or brief fields) + provenance links |
| **Discovery / research** | Run research lanes (web, docs, video), file findings as memory with sources | memory entries with `source` field; lanes foundation | A research lane kind; artifact capture for findings |
| **Requirements & scope** | Keep scope/no-scope lists; flag scope creep in conversation | decisions log (append-only) | A scope convention over decisions ("scope:" prefix) or a typed field on the brief |
| **Planning** | Tasks with status now/later/done/dropped; milestones grouping them | `tasks` table + UI/CLI ✓ | **Milestones** (a grouping + target), ordering, and "next action" semantics |
| **Decision log** | Append-only decisions with supersedes-chains and source messages | `decisions` table + UI/CLI ✓ (supersedes + provenance columns exist) | UI for superseding; surfacing relevant past decisions in-conversation |
| **Risks / open questions** | Track what is unknown/dangerous; nag until resolved | — | New entity (or typed task class); resolution links to a decision |
| **Artifacts** | Keep generated outputs (briefs, specs, mockups, reports) addressable and replayable | `artifacts` table (spill files) + `artifact.created` event | An artifact *library* surface; artifact kinds; linking artifacts to tasks/decisions |
| **Implementation supervision** | Delegate work to lanes; show progress, budget, and an auditable report; let the human stay responsible | Claude Code lane: mandate→progress→merge report, opt-in real exec, cancel, web panel ✓ | Approvals mid-lane (`approval.*` events exist in protocol, unused); lane → task linkage; multi-lane kinds |
| **QA / verification** | Verify claims: run tests, check links, diff outputs; record verification as events | — (lane reports carry summaries) | A "verify" lane template + verification events tied to tasks |
| **Release readiness** | A doctor-style release checklist per project: gates green, tasks done, risks closed | runtime `doctor` ✓ (runtime-scoped) | A **project-scoped** doctor (companion checklist) |
| **Post-release memory** | Distill what was learned into project + user memory; carry into the next project | memory entries + FTS ✓ | A consolidation flow (the `memory.consolidated` event already exists in the protocol, unused) |

The pattern in the gap column: **almost every missing piece is an entity + events + one honest
panel** — exactly the shape the store/protocol were designed to absorb (entity tables via ADR'd
migrations, `task.*`/`decision.*`-style event namespaces, projection in the reducer).

## 2. How Amrita should behave in the UI

Principle (from the agent-UX research and our own identity): **the UI is a control surface, not a
feed** — start/stop, approvals, receipts, logs, and recovery must be one glance away, and the
chat stays the primary instrument.

Proposed surfaces, in priority order:

1. **Project Home ("Project Brain")** — what the current inspector column grows into, per
   project: brief + goals at top; then *Next actions* (see below); then knowledge panels
   (tasks/decisions/memory — already built); then lanes; then runtime. One screen answers "where
   is this project and what should happen next?"
2. **Next-best-action strip** — a deterministic, *rule-based* list derived from typed state (not
   an LLM guess): unresolved doctor fails → "fix setup"; no brief → "capture the brief"; open
   questions idle > N days → "resolve or drop"; tasks `now` empty → "pick the next task"; lane
   finished → "review the merge report". Honest: when there is nothing to suggest, it says so.
   (This pass ships a first version — see Part C note at the end.)
3. **Timeline / activity feed** — the event log *is* the feed; render `seq`-ordered events
   (messages, decisions, lane reports, task changes) with provenance links. Replayable by
   construction; no new storage.
4. **Conversation + plan side-by-side** — chat in the middle (exists), plan panels beside it
   (exists); the missing link is *cross-referencing*: clicking a decision scrolls to its source
   message (`source_message_id` is already stored).
5. **Lane supervisor view** — the Lanes panel grown up: per-lane budget burn, the full progress
   log (not just the last note), the merge report rendered as a receipt, and pending
   `approval.requested` cards with allow/deny (protocol events exist; daemon plumbing is the
   work).
6. **Setup / Connectors page** — the doctor report plus a typed connector list (the `connectors`
   table exists) with `needs_setup / ready / error / disabled` and the exact next command. Never
   a fake green light.
7. **Operator mode (mobile/Telegram)** — Natanel's phone loop: Telegram (once the bot runner
   ships) for "status?", "approve lane 3", "add task: …", "what's next?"; the narrow-viewport web
   already reflows for phone browsers. Operator mode is *supervision-first*: approvals, next
   actions, and lane progress — not full editing.

## 3. What makes Amrita different from generic chat

These are already true in code, and the companion work compounds them:

- **Project-scoped memory** — memory entries are scoped `user|project` with budgets and FTS;
  conversations belong to projects; nothing is a global soup.
- **A typed event log as the source of truth** — every boundary crossing is a Zod-parsed event
  with per-conversation `seq`; the UI is a fold over it; history replays deterministically.
- **Provenance everywhere** — decisions/tasks/memory carry `source_message_id` / conversation /
  lane links; the companion can always answer "why does the plan say this?"
- **Lanes are supervised workers, not shells** — mandate → progress → merge report is a hard
  schema boundary, with budgets, cancellation, env-scrubbing, and opt-in real execution. This is
  the Linear delegation insight (the agent contributes, the human remains responsible) enforced
  at the protocol level.
- **Honest connectors** — `needs_setup` is a first-class state; doctor says exactly what to run;
  no integration ever pretends. (The ecosystem's trust problem — only ~13% of public MCP servers
  meet a "high trust" bar — makes honesty a differentiator, not a nicety.)
- **One protocol, many channels** — web, CLI, and Telegram speak the same RPC/event vocabulary;
  operator mode is a channel, not a fork.
- **Local-first** — SQLite + localhost daemon + env-name-only secret refs; the 2026 wave of
  local-first agents (Hermes, OpenHuman, Memory OS) validates this posture, and Amrita's
  event-sourcing is *stricter* than most of that wave.

## 4. Extension and plugin model

Direction: **connectors are typed manifests in the store; execution surfaces are lanes or MCP
tools; everything is opt-in and doctor-visible.** The MCP registry (≈10k public servers,
registry-as-metadata, downstream curation expected) is the obvious substrate for breadth, with
Amrita curating a small trusted set rather than exposing a firehose.

Per category:

| Category | Value to accompaniment | MVP path | Secrets boundary | UI status | Tests | Opt-in gate |
|---|---|---|---|---|---|---|
| **Agent lanes** (Claude Code ✓, Codex, OpenCode, Gemini CLI) | The hands: implementation, refactors, reviews | Generalize `ClaudeCodeLaneRunner` → a lane-kind registry keyed by `lanes.start{kind}`; same mandate/report contract | Env-scrub stays deny-by-default; each CLI authenticates itself (subscription login); never forward API keys | Lane card shows kind badge + posture | Fake/injected runners (pattern exists) | `AMRITA_LANES_ALLOW_REAL_EXECUTION` + per-kind allowlist |
| **Design lanes** (Open Design, Figma import/export) | Mockups/assets as artifacts beside the plan | Start with artifact import (file → artifact row + event); real design-tool auth later | OAuth only via official flows; tokens env-ref'd like provider keys | Artifact library entries with source badge | Fixture files | Explicit connector enable |
| **Research lanes** (web search, docs, arXiv/YouTube/transcripts) | Discovery stage; findings → memory with sources | A `research` lane kind whose runner calls an injected fetch/search fn; findings land as `memory.updated` with `source` URLs | Network egress is the risk: scope-limited allowlist in the mandate (`scope.network` exists, currently advisory — must become enforced before real research lanes) | Lane card + memory entries with source links | Injected fake search/fetch | Per-lane network scope |
| **Productivity connectors** (GitHub, Linear, Notion, Drive, Calendar, Slack/Telegram) | Two-way sync: tasks ↔ issues, decisions → docs, schedules | GitHub first (repo already local; `gh`/token via env-ref): import issues → tasks with provenance; one-way before two-way | Official tokens only, env-name refs in `accounts`/`connectors`; no token values in store/events | `connectors` rows: needs_setup/ready/error + last sync receipt | Recorded/faked HTTP via injectable fetch (pattern exists) | Per-connector enable + doctor check |
| **Knowledge connectors** (Obsidian, local folders, Git repos, web docs, uploads) | Project knowledge beyond chat: specs, notes, code | Local folder/Git ingest first (no auth): files → artifacts + memory index; path-jailed (§7 of PLAN, ported from v0.1) | Path jail + read-only by default | Source listed in artifact library | Temp-dir fixtures | Per-root allowlist (like `AMRITA_LANES_ALLOWED_ROOTS`) |
| **Runtime/tool connectors** (MCP servers, CLI tools, Playwright, Docker) | Tools inside turns: the `tool.*` event namespace is fully specced and unused | An MCP *client* is explicitly a v2.0 non-goal (PLAN §6) — adding it needs an ADR. MVP: a curated typed tool registry (N hand-written tools) exercising `tool.requested/approved/started/output/completed` + spill | Tools run under the daemon; same env-scrub discipline; approvals via `approval.*` | Tool calls render in transcript with receipts | Fake tool impls | Per-tool approval policy (`forward`/`auto-safe`) |
| **Deployment connectors** (GitHub Actions, Vercel/Netlify/Fly, Docker VPS) | Release stage: deploy + verify as supervised lanes | Last. A `deploy` lane kind wrapping official CLIs with mandate-scoped env; verification step built in | The most dangerous category: production mutation requires `approval.requested` → human allow, always | Release checklist panel + lane receipt | Dry-run modes of the CLIs; never real deploys in tests | Double gate: connector enable + per-run approval |

**Manifest sketch** (next ADR, not this pass): a `ConnectorManifest` Zod schema —
`{slug, kind, title, capabilities[], requiredEnv[] (names only), setupCommands[], docsUrl}` —
stored in the existing `connectors.manifest_json`, validated at registration, rendered by the
setup page, and checked by doctor (env presence by name, never value).

## 5. Inspiration — what to adopt, avoid, and own

| Source | Adopt | Avoid |
|---|---|---|
| **Claude Code / MCP ecosystem** | Mandate-like task framing; plugin manifests; registry-as-metadata with downstream curation | Exposing an uncurated server firehose (low median trust); shell-level freedom by default |
| **Linear agents** | Delegation semantics: agent is a *contributor*, human stays the assignee/responsible; agent activity visible like a teammate's | Treating agents as magic assignees with no receipt trail |
| **Cursor / Windsurf / Devin-style supervision** | The control surface: plan preview → approve → execute → receipt; budget and progress always visible; graceful interrupt | "Watch the agent type" theater; burying the log |
| **Notion / Obsidian** | Knowledge lives beside work, linkable both ways; local-first files (Obsidian) as a connector, not a copy | Becoming a freeform doc tool — Amrita's knowledge is *typed* (tasks/decisions/memory), that's the moat |
| **GitHub Projects / Jira** | Milestones as thin groupings over tasks; status taxonomies kept tiny | Workflow-engine complexity (custom fields/automations) — v0.1's `now/later/done/dropped` is a feature |
| **Hermes / OpenHuman / Memory OS (local-first wave)** | Persistent local memory as the product; background consolidation loops (Hermes patterns are already mined in docs/hermes-architecture-notes.md) | Vector-store-first memory before typed memory is exhausted (vectors are an explicit v2 non-goal until an ADR) |

**Uniquely Amrita:** the *constitution* — one Zod protocol + event-sourced store under every
channel and every agent, with honesty as a product invariant. Nobody in the inspiration set has
all three of: typed replayable history, supervised lanes with hard report schemas, and
needs-setup-honest connectors.

## 6. Roadmap

### Stage 0 — Now (this pass + next 1–2 build sessions): "Companion seams"
- **User-visible:** role-based provider policy (✓ shipped this pass); next-best-action strip with
  honest empty state (✓ this pass, rule-based); doctor fixes rendered in the web (✓ this pass).
- **Backend:** ADR-0018 drafting for companion entities (brief/milestones/open questions); no
  schema change yet.
- **Tests/smokes:** pure-reducer tests for next-actions (✓); smoke doc addition.
- **Risks:** none material — additive.
- **Acceptance:** all gates green; next-action strip renders only truths derivable from typed
  state.

### Stage 1 — Internal alpha: "Project Companion Core"
- **User-visible:** project brief (goal, success criteria, scope) captured from chat and shown at
  the top of Project Home; open questions & risks tracked and nagged via next actions; milestones
  grouping tasks; timeline view over the event log.
- **Backend/store:** migration `0002_companion` (ADR-0018): `project_briefs` (or columns on
  `projects`), `open_questions` (status open/resolved/dropped, `resolved_by_decision_id?`),
  `milestones` (+ `tasks.milestone_id?`). New event namespaces `brief.*`, `question.*`,
  `milestone.*` (ADR per protocol rule). Reducer projections + invariants (e.g. resolving a
  question requires a decision or an explicit drop reason).
- **UI:** Project Home layout; brief card with inline edit; questions/risks panel; timeline.
- **Tests/smokes:** store invariants up/down/up; reducer round-trips; UI api-wrapper tests; smoke
  doc chapter "give Amrita a brief".
- **Risks:** schema churn → mitigate by ADR-first and keeping brief fields minimal (goal,
  successCriteria[], scope/noScope[]).
- **Acceptance:** a new project can go intake → brief → tasks/milestones → decisions → questions
  resolved, entirely through chat + panels, with every item provenance-linked.

### Stage 2 — Companion beta: "Operator Mode"
- **User-visible:** Telegram live bot runner (long-poll, deny-by-default allowlist already
  tested) answering status/next-actions/approve; `approval.requested/resolved` wired through
  lanes and rendered in web + Telegram; lane→task linkage ("this lane is working task X").
- **Backend:** bot runner process under the daemon (token via env-name ref, doctor-checked);
  approvals plumbing in the lane runner (pause on `approvals: 'forward'`).
- **UI:** lane supervisor view (full progress log, budget burn, approval cards).
- **Tests/smokes:** bot runner with injected transport (no real Telegram in tests); approval
  round-trip tests; smoke chapter "supervise from your phone".
- **Risks:** approval deadlocks (lane waits forever) → timeouts that abort to `partial` with a
  receipt.
- **Acceptance:** Natanel can, from Telegram: see project status, get the next actions, approve
  or deny a lane's request, and receive the merge report.

### Stage 3 — Extension ecosystem: "Setup Hub + first connectors"
- **User-visible:** Connectors page (typed manifests, honest states, setup commands); GitHub
  issues↔tasks one-way import; local-folder knowledge ingest; a `research` lane kind.
- **Backend:** ConnectorManifest schema (ADR), connector doctor checks, the curated tool registry
  exercising the `tool.*` event path; enforced (not advisory) network scope for research lanes.
- **UI:** setup hub; artifact library v1.
- **Tests/smokes:** manifest validation; fake-HTTP connector tests; path-jail regression tests
  (ported from v0.1 §7).
- **Risks:** scope explosion → hard cap at 2 connectors + 1 lane kind for the stage; MCP client
  remains out until its own ADR.
- **Acceptance:** doctor + setup hub show every surface's true state; one external system (GitHub)
  round-trips into typed project knowledge with provenance.

## 7. Recommended next implementation phase: **Project Companion Core** (Stage 1)

Why this and not Operator Mode or the Setup Hub first:

1. **It is the product.** Operator mode supervises *something*; the setup hub connects *to
   something*. Without brief/goals/questions/milestones, Amrita is a chat with side panels — the
   companion claim isn't real yet. With them, every later stage gets leverage (Telegram "what's
   next?" answers from typed state; connectors import *into* a structure).
2. **The architecture is visibly ready.** Entity tables + event namespaces + reducer projections
   + panel UIs is a path this repo has now walked four times (tasks, decisions, memory, lanes).
   Risk is low and the muscle memory is fresh; the only novel work is the intake flow.
3. **It compounds the moat.** Provenance-linked briefs/questions/decisions deepen exactly the
   thing generic chat products can't copy cheaply (typed, replayable project state).
4. **Operator Mode gets strictly better by waiting** — approvals and Telegram are far more
   valuable when "status" and "next" have typed answers.

Scope guard for the phase: brief + open questions + milestones + timeline + next-actions v2,
**nothing else** — no connectors, no MCP, no new lane kinds.

## Honest limitations (as of this document)

- Everything in §1's "Gap" column and Stages 1–3 is **conceptual until its ADR + migration
  lands**; nothing here is pre-implemented behind flags.
- Real-provider SSE streaming, the Telegram live bot runner, MCP client support, network-scope
  *enforcement* for lanes, and all deployment connectors **require either secrets, official auth,
  or explicit human approval**, and must never be simulated as working.
- The next-best-action strip shipped with this pass is **rule-based over typed state**, not an
  LLM planner — that's deliberate (deterministic, honest), and an LLM-suggested layer on top is a
  later, clearly-labeled addition.

## Sources (web research, June 2026)

- MCP registry state & curation: [Official MCP Registry](https://registry.modelcontextprotocol.io/), [The MCP Registry — about](https://modelcontextprotocol.io/registry/about), [2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/), [MCP adoption statistics 2026](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol), [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry), [Claude Code plugins ecosystem](https://groundy.com/articles/claude-code-plugins-anthropic-s-official-plugin-ecosystem/)
- Agent supervision UX: [Designing for AI Agents: 10 UX patterns (2026)](https://mantlr.com/blog/designing-for-ai-agents-ux-patterns-2026), [Agent UX patterns — chat-first fails](https://hatchworks.com/blog/ai-agents/agent-ux-patterns/), [Secrets of agentic UX](https://uxmag.com/articles/secrets-of-agentic-ux-emerging-design-patterns-for-human-interaction-with-ai-agents), [Agentic UX design patterns](https://www.eleken.co/blog-posts/agentic-ux-examples)
- Delegation/PM patterns: [AI agents in Linear](https://linear.app/docs/agents-in-linear), [Linear for Agents](https://linear.app/agents), [Notion as an agent hub (TechCrunch)](https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/)
- Local-first agent wave: [Hermes Agent](https://hermes-agent.org/), [Memory OS on Hermes](https://www.marktechpost.com/2026/06/01/meet-memory-os-a-6-layer-open-source-memory-stack-built-on-top-of-hermes-agent/), [OpenHuman guide](https://tosea.ai/blog/openhuman-personal-ai-agent-guide-2026), [Open-source personal AI agents (SitePoint)](https://www.sitepoint.com/the-rise-of-open-source-personal-ai-agents-a-new-os-paradigm/)
