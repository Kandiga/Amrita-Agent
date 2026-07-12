# Amrita v2 Reorganization — Master Plan (Phases 3–8 + Roadmap)

> Planning document (2026-07-11), produced with the STORM multi-perspective loop.
> Evidence base (Loop 0): `docs/AMRITA_ROOT_CAUSE_AUDIT.md` + `docs/HERMES_INSPIRATION_RESEARCH.md`
> (both same session, file:line-backed). Labels: [FACT] verified · [ASSUMPTION] · [DECISION].
>
> **Binding constraint (Natanel, 2026-07-11): no canvas, preview windows, design runtime,
> or any shiny feature before core stability and root-cause/SSOT closure (roadmap stage R0).**
> This document *plans* those features; it does not authorize building them out of order.

## 0. Lens summary & disagreement ledger (STORM Loops 1–2)

| Lens | Verdict |
|---|---|
| Practitioner | The audit's R-1/R-2 (protocol jurisdiction + exported enums) are 2–3 focused slices on existing seams; everything later gets cheaper after them. Build on proven patterns already in-repo (approval broker, sandbox harness, lane contract). |
| Academic | Amrita already has the right formal core (event sourcing, typed contracts, ADR gating). The missing theory is *closure*: contracts must cover every boundary, or the formalism is decorative. |
| Skeptic | Biggest failure mode: planning docs become shelf-ware while feature pressure (cinema, previews) keeps landing on the drifted base. Mitigation: R0 is small, gated, and blocks everything. Second failure mode: copying Hermes' monolith energy — adopt its *ideas*, never its module shapes. |
| Economist | The expensive assets are already paid for (store, kernel, tests). R0 is days, not weeks, and de-risks every later stage. Preview/design runtime are high-wow but zero-value if the web boundary can silently break (audit B-1). Order: cheap-closure → brain → channels → wow. |
| Historian | v0.1→v2 already proved "rebuild on typed seams" works. Hermes proves cron/heartbeat/session-identity matter in production and that monoliths rot. The repo's own history (ledger drift, unpushed work) proves governance needs a mechanical gate, not good intentions. |

| # | Conflict | Decision |
|---|---|---|
| 1 | Ship features fast vs close the core first | **Core first** — R0 blocks all stages (user directive + skeptic + economist agree). |
| 2 | v2 shares the GitHub repo with frozen v0.1 (push-hazard, audit §6) vs separate repo | **Recommend: align local branch name to `v2-main` now (safe, local); propose a dedicated `amrita-v2` GitHub repo as an approval-gated follow-up.** Remote mutations need Natanel's explicit approval. |
| 3 | Split `kernel.ts` (1,952 LOC) now vs later | **Later, deliberately** (R2) — after R0 contracts land, guarded by the invariance suite. Not opportunistic. |
| 4 | Global Amrita as a new protocol scope vs a reserved system project | **Reserved system project first** [DECISION] — envelope requires `projectId` [FACT: PLAN §3.1]; a reserved project needs zero schema break; a first-class scope can come later via ADR if it earns it. |
| 5 | Claude-CLI preview window as direct exec vs lane contract | **Lane contract** — product direction forbids ad-hoc runtime buttons [FACT: product-direction rule]; the window is a *view over a lane*, not a new execution path. |
| 6 | Skills discovered from filesystem (Hermes-style) vs typed registry | **Typed registry with Zod manifests** + filesystem as one loader. Registry, permissions, and docs are mandatory per skill (user directive). |
| 7 | Conversation compression: rewrite history vs child-session lineage | **Lineage** — `conversations.parent_id` already exists [FACT: ADR-0003]; Hermes' compaction-as-child-session is the proven shape; event log stays append-only. |
| 8 | Specs layer: refresh prose vs demote to generated views | **Demote-or-refresh per file** (audit R-7): `store.md` stays (in lock-step); the stale four get a "code is authority" banner + refresh in the phase that touches them. |

## 1. Phase 3 — Session architecture & Project Brain

**Objective:** every project conversation runs inside a defined session architecture, and
the Project Brain becomes the complete, persisted, provenance-carrying working memory of a
project: memory · decisions · tasks · files · git · index · compress.

**Current state [FACT, audit §2/§4]:** companion core (brief/questions/risks/milestones/
tasks/decisions/timeline) is real and tested; `memory_entries` real; brain harness
(ADR-0027) is a *derived projection* with manual capture; `knowledge_records` persistence
deferred; **no** conversation compression; **no** project file/git context; skills don't
exist as a concept in v2.

### 1.1 Project Brain target model

| Component | Today | Target | Mechanism |
|---|---|---|---|
| Memory | `memory_entries` (scope user/project, char budget) | + curated two-file discipline: per-project `brain notes` vs `user facts` split with char caps + write gate (Hermes §1 lesson) | extend memory APIs; no new table needed initially [DECISION] |
| Decisions | append-only `decisions` table ✅ | unchanged (already correct) | — |
| Tasks | `tasks` + external refs ✅ | unchanged | — |
| Files | none | typed **project file index**: root path, tracked globs, per-file role annotations, staleness | new `project_files` concept — ADR required; start as harness *source* (`kind: repo`) feeding knowledge records |
| Git | none | read-only git context probe (branch, dirty count, ahead/behind, last commit) surfaced in brain + doctor | daemon prober (like `runtimes.ts` probes) — no protocol change for probe-only [DECISION] |
| Index | harness projection (derived, not persisted) | persist `knowledge_records` + `harness.*` events — ADR-0027's documented migration path, triggered by the first automatic ingest (repo/git source above qualifies) | ADR + reversible migration |
| Compress | none | **compaction-as-child-session**: summarize an over-budget conversation into a new conversation with `parent_id` lineage + a `conversation.compressed` event; original stays replayable | ADR; uses existing `parent_id` [FACT: ADR-0003] |

Session architecture [DECISION]: a *session* = one conversation + its resolved runtime
context (provider bindings via `resolveRole`, lane defaults, channel origin). Already
80% true in code; the missing piece is compression + a typed `session.context` RPC so
every surface (web/telegram/cli) renders identical context. No new store table.

### 1.2 Skills: System / Shared / Project

Taxonomy [DECISION]:
- **System skills** — ship with Amrita, versioned in-repo, not user-editable.
- **Shared skills** — user-installed under `~/.amrita/skills/`, available to all projects.
- **Project skills** — live in the project's own directory, scoped to it.

Mandatory per skill (user directive — enforced by schema, not convention):
1. **Registry entry**: Zod `skillManifestSchema` in `@amrita/protocol` (name, tier,
   version, description, owner, permissions, docs pointer). Unregistered = not loadable.
2. **Permissions**: per-skill toolset grants + per-channel availability (Hermes
   `platform_toolsets` lesson, §7) — deny-by-default; agent-created skills flagged and
   write-gated (curator invariants: archive-never-delete, pinned untouchable).
3. **Docs**: manifest requires a non-empty usage doc; doctor reports skills with missing
   docs as WARN.

**Deliverables:** 1 ADR (brain persistence + compression + skill registry may be 2–3 ADRs
by protocol rules), migrations, protocol schemas, kernel APIs, RPC verbs, CLI verbs,
BrainPanel extension. **Tests:** compression lineage round-trip; write-gate refusal;
skill manifest parse/refusal; permission deny-by-default. **DoD:** brain view shows
files/git/index honestly; a 200-message conversation compresses into a child session and
replays; an unregistered skill cannot load.

## 2. Phase 4 — Preview Windows + Claude CLI remote window

**Objective:** typed, approval-gated preview windows in the web UI, including a window
that shows and controls a **remote Claude Code CLI session running on Hostinger**, with
mode control (plan / ask / auto) and permission control.

**Current state [FACT]:** lanes execute Claude Code behind mandate→report (ADR-0014/15);
approval broker gates real runs (ADR-0021); `lane.progress` + delta bus stream live
(ADR-0016); sandbox harness exists (`apps/web/src/sandbox.ts`); `.claude-remote-logs/`
proves ad-hoc remote-control sessions already happen on this box — unmodeled.

**Design [DECISION — all through existing seams]:**
- A `PreviewWindow` is a typed artifact surface, not a new runtime: `window.kind ∈
  {lane-console, html-preview, artifact}`. The **Claude CLI window** is `lane-console`
  rendering an *existing lane's* mandate, live `lane.progress` stream, and MergeReport —
  a view over the lane contract, never a second execution path (conflict #5).
- **Mode control** maps UI modes to the mandate's `approvalPolicy` + the CLI's permission
  mode: `plan` → read-only planning run; `ask` → every action forwarded to the approval
  broker (web ApprovalsPanel + Telegram /approve); `auto` → pre-authorized within scope
  (still requires the daemon's real-execution opt-in + scope confinement). Honest states:
  a mode the CLI doesn't support renders `unsupported`, never faked [product rule].
- **Permission control**: per-window scope = the lane mandate's workspace jail + env
  scrub (already implemented); UI exposes them read-only first, editable behind approval.
- Remote transport: the browser already talks to the daemon on Hostinger over HTTP/WS
  [FACT] — no new channel needed; CORS stays deny-by-default (Phase-7 commit).

**Prereqs:** R0 (the WS/RPC contract this window rides on must be schema'd first — audit
B-1/B-2). **Tests:** mode→policy mapping unit tests; approval round-trip e2e; jail
regression. **DoD:** start a plan-mode lane from the web, watch live progress, approve
one step from Telegram, see the MergeReport — all typed end-to-end.

## 3. Phase 5 — Design Runtime (native, original)

**Objective:** Amrita can design, present, and interactively preview sites/animations —
inspired by the Flyer cookbook and Open Design **as references only**; the runtime is
Amrita's own Native Interactive Surface, extended (never a plugin/copy) [product rule].

**Current state [FACT]:** Surface Stage A (deterministic artifacts) + Stage-B sandbox
harness + hash-based preview approvals (ADR-0020) shipped; Stage B/C pipelines are
docs-only (audit M-3).

**Design [DECISION]:**
- Extend `ArtifactSpec` with design kinds: `design-page`, `design-animation`,
  `design-asset-board` — each a *typed spec* (layout tokens, palette from `project_brands`,
  content blocks) rendered by a deterministic renderer first (Stage A discipline), then
  optionally by generated HTML inside the existing sandbox (allow-scripts-only,
  zero-network CSP) behind the existing hash-approval lifecycle (Stage B).
- Flyer-cookbook lesson imported as *method*, not dependency: deterministic HTML/CSS
  typesetting for text; generated imagery enters only as approved asset files with
  provenance records in the brain.
- Interactivity = seek/state-driven previews in the sandbox; no arbitrary network, no
  tokens in the iframe — the ADR-0020 security plan already fixes these rules.
- Animations: author as self-contained HTML compositions previewed in the sandbox
  [ASSUMPTION: rendering-to-video stays out of scope for this repo — it belongs to
  module federation like cinema, via mandate].

**Prereqs:** R0 + Phase-3 brand/brain surfaces + Phase-4 window plumbing. This is
deliberately the **last** roadmap stage. **DoD:** a brand-aware `design-page` spec
renders deterministically, previews interactively in the sandbox, and carries an
approval hash; drift demotes honestly.

## 4. Phase 6 — Global Amrita + System Brain

**Objective:** a global conversation channel that manages *all* projects, backed by a
System Brain capable of Health, Audit, Feature-Plan, and Management over projects.

**Design [DECISION]:**
- **Reserved system project** (`slug: system`, guarded id) — global chat is a normal
  conversation inside it; zero protocol break (conflict #4). Its brain aggregates
  *read-only projections* over all projects' briefs/milestones/risks/gaps.
- **System Brain capabilities** (each an honest, typed verb — no vague "management"):
  - `system.health` — daemon doctor + per-project git/gates probes (Phase-3 probers
    reused) + heartbeat status. Adopt Hermes' **two-signal heartbeat** (alive vs
    productive) for the daemon and any scheduler (research §4).
  - `system.audit` — cross-project gap report from harness projections (stale briefs,
    unresolved questions, ledger-vs-commits drift — the exact class of finding this
    session found by hand becomes a standing capability).
  - `system.plan` — drafts a feature-plan record into a target project's brain
    (provenance: `system`), never executes.
  - `system.manage` — delegation: issues mandates into project lanes (the cinema-mandate
    pattern ADR-0029 generalized), always through the approval broker.
- **Scheduler layer** (prereq for health): minimal cron with Hermes lessons — jobs.json
  equivalent in the store (typed), `no_agent` script jobs + agent jobs, deny-by-default
  approvals in scheduled context, dated output archive, two-signal heartbeat. OS
  supervision stays systemd (Amrita's honest install path), not self-supervision.

**Prereqs:** Phase 3 (brain persistence — the System Brain reads it) + R2 (operator
service). **DoD:** `/global` chat answers "what needs attention across projects" from
projections with provenance; a scheduled health job posts only on problems (silent on
success — Hermes watchdog convention).

## 5. Phase 7 — Multi-Channel Adapters (no memory duplication)

**Objective:** Web, Telegram, WhatsApp, Terminal — one brain, zero duplicated memory.

**Current state [FACT]:** web + Telegram + CLI live; all route through
`kernel.runChatTurn`; invariance tests prove cross-channel/cross-project memory unity;
operator logic wrongly lives in the Telegram adapter (audit C-1).

**Design [DECISION]:**
1. **Extract the operator-command service into the kernel** (audit R-9) *before* any new
   channel: `/status /approve /deny /stop` become typed kernel verbs; channels only
   render. This is the anti-duplication keystone — WhatsApp must not re-implement
   approval disambiguation.
2. **Session-key identity** (Hermes §6): deterministic `channel × chat × user → conversation`
   mapping in one kernel resolver; group-scope isolation policy explicit. Formalizes the
   guarantee that already holds, and makes it testable for every future channel.
3. **Telegram JSON boundary**: give inbound updates a protocol schema (audit B-3 fix).
4. **WhatsApp**: adapter behind the same `Channel` contract; official Cloud API only
   (honest-integrations rule — no unofficial bridges [DECISION]); ships `needs_setup`
   until configured with exact fix commands.
5. **Terminal**: `amrita chat` already exists; gains the same operator verbs via the
   kernel service (free once #1 lands).
6. **Fitness function**: a test that runs the same turn through two channels and asserts
   single-conversation state (extends the invariance suite).

**DoD:** operator commands answer identically on all channels from one kernel service;
WhatsApp adapter passes the same channel-contract suite as Telegram; the two-channel
memory fitness test is green.

## 6. Phase 8 — Repo governance: branch, tags, changelog, rollback

**Current state [FACT, audit §6]:** local `main` tracks remote `v2-main` (ahead 12);
remote `main` = frozen v0.1 (clobber hazard); zero tags; no changelog; rules files
untracked; ledger stale.

**Design [DECISION — local steps safe; remote steps approval-gated]:**
1. **Branch**: rename local `main` → `v2-main` (matches upstream; kills the push-hazard
   ambiguity). Follow-up proposal for Natanel: dedicated `amrita-v2` GitHub repo, keeping
   `Amrita-Agent` as the v0.1 archive (conflict #2) — remote op, needs approval.
2. **Tags**: annotated `v2.0.0-alpha.1` at the reorganization-closure commit; a tag per
   roadmap stage thereafter. Tags are the rollback anchors.
3. **Changelog**: `CHANGELOG.md` generated from conventional commits (already enforced
   [FACT: CLAUDE.md #5]) per tag; the ledger stays the narrative receipt, the changelog
   the release receipt — two views, one commit history, no duplication.
4. **Rollback recipe** (documented in the changelog header): checkout tag → reversible
   migrations down (`migrate.ts` supports down [FACT]) → restart daemon; DB backup before
   any migration-bearing upgrade (config-backup lesson, research §8).
5. **Phase-done checklist** (mechanical, in `AGENTS.md`): gates green · ledger entry ·
   ADR if protocol/store touched · pushed · tagged if stage-closing. The audit's fitness
   functions (§8) become part of it.

## 7. The staged roadmap (execute in order; each stage gated)

> Rule: **a stage does not start until the previous stage's gate is green.**
> R4/R5 are explicitly forbidden before R0–R1 close (user directive).

| Stage | Content | Gate (Definition of Done) |
|---|---|---|
| **R0 — Core closure** (audit R-1…R-7): protocol jurisdiction over RPC results + WS frames; export enums, kill all inline copies; web depends on protocol + parses; contract test web↔daemon; track `.claude/rules/`; ledger backfill (cinema); resolve CLAUDE.md WIP; local branch rename; spec demote/refresh banners | 2–4 focused slices, each ADR-gated where protocol changes | All fitness functions green: no inline enums (grep gate) · web imports protocol · every ADR-phase has a ledger entry · tree clean · gates 100% · first push after approval |
| **R1 — Project Brain completion** (Phase 3): compression-as-lineage; `knowledge_records` persistence; file/git context probes; skill registry (System/Shared/Project) with permissions + docs mandatory | ADRs + migrations + tests per §1 | Brain shows files/git/index honestly; compression round-trip test; unregistered skill refused; 100% gates |
| **R2 — Channel & kernel hygiene** (Phase 7 first half + audit R-8/R-9/R-10): operator service extraction; session-key resolver; Telegram schema boundary; config authority unification; deliberate kernel split along companion/approvals/cinema/harness seams | invariance suite is the guard | Operator verbs identical across channels; kernel modules < ~800 LOC each; invariance green |
| **R3 — Global Amrita + scheduler** (Phase 6): reserved system project; system.health/audit/plan/manage; minimal typed cron + two-signal heartbeat | | Global chat answers cross-project status with provenance; silent-on-success health job runs; heartbeat visible in doctor |
| **R4 — Preview Windows** (Phase 4): lane-console window; Claude CLI remote with plan/ask/auto; approval round-trip | forbidden before R0–R1 gates | E2E: start plan lane in web → approve from Telegram → typed MergeReport |
| **R5 — Design Runtime** (Phase 5): design ArtifactSpecs; deterministic renderers; sandboxed interactive previews behind hash approvals | forbidden before R0–R1 gates; wants R4 windows | Brand-aware design-page previews + approval lifecycle; zero network in sandbox |
| **R6 — Multi-channel expansion** (Phase 7 second half): WhatsApp adapter (official API, needs-setup honest), terminal parity polish | after R2 | Channel-contract suite green for WhatsApp; two-channel memory fitness test |

Cross-stage rules: every stage ends with the Phase-8 checklist (gates · ledger · push
approval · tag on stage close); protocol/store changes only via ADR; secrets invariants
untouchable; honest integrations always.

## 8. Verification & claim safety (STORM Loop 5 — judge pass)

- Sources inspected: full repo scan (3 read-only exploration passes with file:line
  evidence), live gates run (396/396), git/remote state verified, live Hermes install
  read. Facts labeled throughout; the few assumptions are marked [ASSUMPTION].
- Judge findings applied: roadmap re-ordered so kernel split waits for contract closure
  (was tempting to do early — skeptic overruled); Global-Amrita schema change demoted to
  reserved-project (avoids a protocol break the evidence doesn't justify yet); WhatsApp
  demoted below the operator-service extraction it depends on.
- Open questions for Natanel (do not block R0): (1) dedicated GitHub repo for v2 —
  yes/no; (2) commit or relocate the CLAUDE.md prompt-copilot hunk; (3) when to schedule
  the first approved push of the 12 local commits.

## 9. Next action

Start **R0 slice 1**: ADR for protocol RPC-result schemas + WS frame union, then the
enum export sweep. Everything else waits behind it.
