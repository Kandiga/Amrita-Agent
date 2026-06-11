# Amrita Native Interactive Surface — corrected north star

- **Date:** 2026-06-11
- **Status:** Accepted direction (source of truth for the v3 product correction). Implementation
  phases land via their own ADRs.
- **Supersedes:** the "Design lanes (Open Design …)" row in
  [project-companion-roadmap.md](project-companion-roadmap.md) §4 — see the supersession note
  there.

## The correction, stated plainly

**Open Design is not an Amrita plugin, dependency, embedded product, or visible integration.**
Open Design / Claude Design may be *studied as inspiration only*. They never appear as "the
engine" inside Amrita, are never required to run Amrita, and never define Amrita's brand or UI.

The corrected model:

```
Amrita                       = native, chat-first Project OS / project brain / supervisor
Claude Code (and successors) = managed execution runtimes — the hands, never the brain
Native Interactive Surface   = Amrita's OWN canvas/preview/artifact engine, fed by typed project state
Project state                = brief · milestones · questions · risks · tasks · decisions · memory · timeline (ADR-0018)
Installer/runtime            = a real desktop product (Windows first) that preserves daemon/CLI mode
Provider/runtime layer       = dynamic, user-visible, swappable model/provider/agent selection
Self-maintenance             = audited, diffable, reversible upkeep of Amrita's own rules/skills
```

## 2.1 Product model

Layout (desktop): **left** projects/conversations · **center** chat · **right** the inspector
growing into two modes — *Project Brain* (today's panels) and *Surface* (artifacts/previews).
Mobile/narrow: the existing reflow (inspector below chat as a card grid) evolves into
tabs/sheets — chat | brain | surface — never a squeezed three-column desktop.

The loop the user lives in:

1. Talk to Amrita about the project.
2. Amrita updates typed state (brief/questions/risks/milestones/decisions — shipped, ADR-0018).
3. Amrita renders or updates an **artifact** on the Surface (brief summary, milestone board,
   palette, prototype...).
4. The user compares/selects/approves on the Surface.
5. Amrita hands off to a coding lane (Claude Code) with brief + brand memory + the approved
   artifact + acceptance criteria.
6. Amrita verifies and shows a **receipt artifact** (build/test/QA results, lane merge report).

Everything on the Surface traces to typed state. Nothing on the Surface is sample data.

## 2.2 Artifact types

A typed `ArtifactSpec` union (discriminated on `kind`). Staged:

| Kind | Value | Minimal schema | Render | Stage |
|---|---|---|---|---|
| `brief-summary` | the project on one card | goal, audience?, criteria[], scope[], noScope[] | deterministic component | **A (shipped this pass)** |
| `milestone-board` | plan at a glance | milestones[{title,status,targetDate?,openTasks}] | deterministic component | **A (shipped this pass)** |
| `decision-comparison` | options side-by-side | options[{title,pros[],cons[],source?}] | deterministic component | A |
| `qa-report` / `lane-receipt` | proof of work | checks[{label,status,detail}], laneId? | deterministic component | A |
| `color-palette` / `brand-board` | visual identity | swatches[{name,hex}], type/tone notes, assetRefs | deterministic component | A/B (needs brand memory) |
| `architecture-diagram` | system shape | nodes/edges (typed graph) | deterministic SVG renderer | B |
| `landing-page` / `ui-prototype` | richer previews | generated HTML/CSS (no secrets) | **sandboxed iframe** | B |
| `simulation` / `data-dashboard` | living artifacts | spec + data series | deterministic charts, then sandboxed | C |
| `implementation-preview` | what the lane built | URL/screenshot/artifact ref + receipt | sandboxed/static | B/C |

Every artifact carries provenance (projectId, source event/entity ids, createdAt) and a state:
`draft → proposed → approved → implemented → verified`. Persistence: the existing `artifacts`
table + `artifact.created` events are the storage seam; Stage-A artifacts are **derived live
from companion state** and need no new storage at all.

## 2.3 Rendering/runtime architecture (security first)

Evaluated: React components from typed specs · sandboxed iframe HTML · JSON→deterministic
renderer · server-generated static files · hybrid. Decision — **staged hybrid**:

- **Stage A (now): structured JSON → deterministic React renderers.** No generated code
  executes. The renderer is a pure function of typed specs; testable like any reducer. This is
  what ships in this pass (`apps/web/src/surface.ts` + the Surface panel).
- **Stage B: sandboxed HTML previews.** `<iframe sandbox>` with *no* `allow-same-origin`, a
  strict CSP, `srcdoc`-injected generated HTML, zero access to the daemon bearer token /
  localStorage / parent DOM. Communication only via `postMessage` with a typed, validated
  message schema. Generated HTML is persisted as an artifact file (spill dir) — never inlined
  into events.
- **Stage C: reviewed interactive components.** Generated component code runs only after
  explicit approval, still inside the Stage-B sandbox; "approve to run" is a first-class UI
  state, not a default.

Hard rules at every stage: no arbitrary unsandboxed JS in the main app; the preview surface can
never read the auth token; no secret values in artifacts/events/previews; artifact payloads are
size-bounded (the D9 spill machinery already exists for big ones).

## 2.4 Brand/design memory

Per-project visual identity Amrita remembers and reuses: palette, typography preference, tone,
logo/asset refs (artifact ids, never binaries in events), UI style principles, accessibility
rules, RTL/language preference, and "do not repeat" visual corrections.

Staged path: **B1** — typed memory convention now (`memory_entries` with `source: 'brand'` and
a JSON content shape validated client-side); **B2** — a `project_brand` companion entity via its
own ADR + migration once the shape stabilizes (the ADR-0018 pattern, sixth walk of the path).
Brand memory is injected into both Surface rendering and Claude Code lane mandates ("this
project is premium dark/cyan/white" survives sessions and channels).

## 2.5 Design quality bar

The Surface is product, not a debug panel: polished typography, clean spacing, premium empty
states that say what will appear and how to cause it, responsive mobile behavior, contrast/
accessibility, RTL safety (`dir` helpers everywhere, as the chat already does), no AI-slop
gradients, explicit artifact states (draft/proposed/approved/implemented/verified), and visual
comparison when alternatives are shown. Reference quality: Linear/Vercel/Stripe/Claude-class
restraint — studied, not cloned.

## 2.6 Claude Code integration (supervision, not replacement)

Amrita composes the **design intent** (brief + brand memory + approved artifact + acceptance
criteria + QA checklist) into the existing `LaneMandate` (`contextPack` is the seam — D7,
ADR-0014/0015). The lane implements; `lane.progress`/`MergeReport` come back over the existing
event stream; the Surface flips the artifact from *proposed* to *implementation preview* and,
after Amrita's verification pass, to *verified receipt*. Amrita manages Claude Code sessions —
budgets, cancellation, approvals (the unused `approval.*` events are the next plumbing) — and is
never reduced to a launcher for them.

## 2.7 Installer/productization path

Windows-first. Full detail in
[windows-installer-and-updates.md](windows-installer-and-updates.md); summary: Electron shell
recommended (the Node + better-sqlite3 daemon runs as a child process unchanged; Tauri would
force a Node sidecar that negates its size advantage), `%APPDATA%/Amrita` for DB/logs,
loopback-only daemon with the existing bearer token auto-provisioned, electron-updater with
signed releases and rollback, CLI/daemon mode preserved forever, first-run wizard backed by the
existing `doctor` report.

## 2.8 Dynamic model/provider/runtime architecture

**Inventory (today, all real):** `providers.list` (mock/anthropic/openai with honest
`available/configuredAccounts/envReady/streaming` booleans), accounts with **env-name-only**
secret refs (ADR-0003/0008), role policy `fast|main|deep` with settings bindings + `auto`
resolution (ADR-0017), per-turn `provider/model/role` overrides on `chat.turn`, doctor checks
with exact fixes, and the Claude Code lane (subscription-CLI auth, never forwarded keys).
There is no Hermes provider bridge in this repo today; Hermes is mined as architecture notes
only (`docs/hermes-architecture-notes.md`). If/when a Hermes provider list/status API is
exposed locally, it enters as one more provider *category* below — discovered, never assumed.

**Provider categories (typed):** local runtime · API-key/BYOK provider · account-auth/
subscription connector (e.g. Claude Code's own login) · Hermes server-side adapter (future,
discovery-based) · coding-agent bridge (§2.9) · MCP/tool connector (future, own ADR — PLAN §6).

**Status model (no fake greens):** `connected` · `configured_but_failing` ·
`available_not_authenticated` · `needs_install` · `manual_setup_required` · `unsupported` ·
`experimental`. The existing doctor warn/fail scoping maps onto this; every non-connected state
carries the exact next command.

**Selection scopes & resolution (deterministic, test-covered):**

```
session/turn override  >  lane/task override  >  project binding  >  global binding  >  auto
```

Global and project bindings live in the existing `settings` table
(`providers.role.<role>` and `project.<projectId>.providers.role.<role>` — non-secret by
construction). *The global→project layers ship in this pass*; lane/task and session scopes are
additive keys on the same resolver. `auto` = first *available* provider, never a configured-but-
broken one; every fallback is user-visible with its reason.

**Routing policy:** capability-based recommendation (cost/speed/privacy/locality/context
length) is a later layer **on top of** the resolver; the user override is always visible and
always wins.

**Secrets/auth safety (unchanged constitution):** the frontend never sees raw secrets; the
daemon reads secret values only at adapter construction from env (OS keychain is an additive
backend later); UI/RPC/events/logs/artifacts carry status booleans and env *names* only; nothing
secret enters Claude Code handoffs (the env scrub is deny-by-default).

**Tests:** disconnected state, configured-with-fake-adapter state, failed auth state,
per-project override resolution, redaction (all existing patterns — injectable fetch/runners,
placeholder fixtures clearly labeled).

## 2.9 Coding-agent bridge abstraction

The lane contract (mandate → progress → merge report) **is** the bridge contract. Formalized:

```ts
interface CodingAgentBridge {
  id: 'claude-code' | 'codex' | 'opencode' | string;
  capabilities(): { models: string[] | 'opaque'; profiles?: string[]; streaming: boolean; ... };
  status(): 'installed_authenticated' | 'installed_unauthenticated' | 'not_installed' | 'unsupported';
  run(mandate: LaneMandate, opts: { signal; onProgress }): Promise<MergeReport>;
}
```

`ClaudeCodeBridge` = today's `ClaudeCodeLaneRunner` (first-class, default). Future
`CodexBridge`/`OpenCodeBridge`/`LocalAgentBridge` implement the same contract behind
`lanes.start {kind}` — no ad-hoc UI buttons; a bridge appears in the UI only when its `status()`
is honestly reported. Model/effort/profile selection passes through where the underlying CLI
supports it (Claude Code: `--model`/effort flags) and reports `unsupported` where it does not —
never silently ignored. Per-project/per-task runtime preference rides the same settings-scope
resolver as §2.8. Workspace permissions, env scrub, budgets, cancellation, and the safety
policy are inherited from ADR-0014/0015 unchanged.

## 2.10 Self-maintenance / skill development

Amrita maintains her own operating knowledge under hard boundaries:

- **What she maintains:** repo-local `CLAUDE.md` / `.claude/rules/*` (stable product truths,
  quality bar), handoff prompt templates, QA checklists, a capability/connector registry,
  stale-doc detection (docs/specs vs code drift), repeated-mistake corrections (as memory
  entries with `source` provenance, surfaced before similar work).
- **Boundaries:** every self-maintenance change is explicit, diffable, reversible, committed
  separately when meaningful, and never touches secrets/auth behavior; broad plugins are never
  installed silently; behavior-changing rules ship with validation/tests; rules record *stable
  truths*, never task progress (progress lives in the ledger).
- **Staging:** S1 (this pass) — the rules files exist and encode the v3 direction; S2 — Amrita
  *proposes* rule/skill diffs as artifacts on the Surface for approval; S3 — approved proposals
  auto-commit with receipts.

## Staged roadmap (this document's delivery plan)

- **Now (this pass):** Stage-A Surface foundation (deterministic artifacts from companion
  state, honest empty states) · global→project model-scope resolver with UI visibility ·
  installer strategy doc · rules files · this document.
- **Next:** brand memory B1 + `decision-comparison`/`qa-report` artifact kinds + approval
  states; provider status model unification behind one typed `RuntimeStatus`.
- **Then:** Stage-B sandboxed HTML previews (security plan above) · Electron shell MVP ·
  `CodingAgentBridge` formal extraction · operator mode (per the companion roadmap, unchanged).
