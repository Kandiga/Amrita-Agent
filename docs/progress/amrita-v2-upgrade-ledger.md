# Amrita v2 Upgrade Ledger

Engineering receipt for the Mega Master Directive v3 work session (2026-06-11).
One ledger, updated per phase — no scattered notes.

## Scope
- **Directive:** v3 — Project Companion + Native Interactive Canvas + Windows installer path +
  provider/runtime control + clean execution discipline. Open Design is **inspiration only,
  never a plugin/dependency/engine** inside Amrita.
- **Branch / start commit:** `main`, ahead 4 of `origin/v2-main` (= `68983b5`); local head
  `7394459` + a 2-file WIP (see Phase 0).
- **Mission summary:** finish Project Companion Core cleanly; consolidate the corrected
  north-star into strategy docs; ship safe first slices (native surface foundation,
  provider/model scope resolution); document the Windows installer path; add repo-local product
  rules; harden, verify, push.

## Phase 0 — Reality inspection
- **Commands run:** `git status/log/diff`, full gates (`pnpm typecheck/lint/test`, web
  `typecheck/test/build`). All green at start: 227 root tests, 39 web tests, build OK.
- **WIP found:** 2 uncommitted files — `packages/daemon/src/rpc.ts` (maps deep `ZodError`s, e.g.
  the companion resolve-needs-evidence refine, to RPC `invalid_params` instead of `internal`)
  and the matching assertion in `packages/daemon/test/companion.test.ts`. Coherent, tested →
  classified **safe to fix now** (folded into Phase 1's hardening commit).
- **Committed-but-unpushed:** `00c04b1` (ADR-0018), `e5981d6` (store migration 0004 + APIs),
  `099a791` (RPC/CLI), `7394459` (web Project Brain). Companion Core is functionally complete:
  brief / questions / risks / milestones / timeline / next-actions v2 across
  protocol→store→daemon→CLI→web, with smoke chapter and a live HTTP smoke already executed
  (brief upsert, evidence-enforced resolve, milestone complete, timeline derivation — all
  verified against a real daemon on a temp DB).
- **Architecture/docs read:** PLAN, ADR-0001…0018, all specs, strategy roadmap, store/daemon/
  web/cli sources (deep familiarity from this work stream).
- **Initial failures:** none.
- **Cleanup/debt map:**
  - `docs/strategy/project-companion-roadmap.md` mentions "Design lanes (Open Design …)" in its
    extension table — conflicts with the v3 correction → **fix now** (supersession note, Phase 2).
  - WO#0 spill writes a file in-tx (flagged in ADR-0006) → **defer** (pre-existing, unrelated).
  - `mandate.scope.network` advisory-only (documented in ADR-0015) → **defer**, already honest.
  - `apps/web/src/App.tsx` is growing large (~1300 lines). Functional and typed, but a
    components/ split is due → **later phase** (deliberate refactor, not opportunistic).
  - No fake states, no debug dumps, no stray TODOs found in touched areas.

## Phase 1 — Project Companion Core
- **Goal:** bring Companion Core to a clean, tested, committed state (it is the foundation the
  native surface attaches to).
- **Files changed (across `00c04b1`…`7394459` + hardening commit):** ADR-0018; migration
  `0004_companion(+down)`; `schema.ts`, `store.ts`, `project.ts` (projection); protocol
  `events.ts` (+10 event types, task↔milestone link); daemon `kernel.ts`/`rpc.ts` (aggregate +
  11 methods + timeline); CLI (13 companion commands); web `api.ts` wrappers, `companion.ts`
  next-actions v2, `App.tsx` Project Brain panels, styles; specs (event-protocol/store/runtime/
  cli/web), smoke chapter, README.
- **Decisions:** brief = full-document upsert; resolve needs evidence (note or decision link),
  drop needs reason — enforced in protocol refine + SQL CHECK + decision-existence trigger;
  timeline derived from the event log (no new storage); task→milestone trigger-enforced (no FK,
  reversible down).
- **Tests:** 227 root (protocol round-trips + refine rejections; migration up/down/up incl.
  targeted; every lifecycle incl. rollback-on-bad-link; RPC aggregate/mutations/timeline; CLI
  flows) + 39 web (next-actions v2 rules, API wrappers). Live HTTP smoke executed.
- **Limitations:** conversational intake/extraction deferred (ADR-0018); no UI for brief
  history (log holds it); risks CLI is symmetric but milestone `update` is RPC-only.
- **Next:** strategy consolidation (Phase 2).

## Phase 2 — Strategy consolidation (`5ca8b14`)
- **Goal:** make the corrected north star the documented source of truth, with no conflicting
  docs left behind.
- **Files:** `docs/strategy/native-interactive-surface.md` (new — §2.1 product model through
  §2.10 self-maintenance, incl. staged rendering security plan, provider categories/status
  model/selection scopes, CodingAgentBridge contract);
  `docs/strategy/windows-installer-and-updates.md` (new — Electron-over-Tauri decision with the
  better-sqlite3/Node-sidecar rationale, W0–W3 stages, Windows file layout, daemon lifecycle,
  first-run wizard from doctor, signed updates + rollback, explicit "nothing claimed yet").
- **Supersessions:** the roadmap's "Design lanes (Open Design …)" row struck and replaced with
  a pointer to the native surface doc; PLAN.md identity line no longer names Open Design as a
  lane example. `grep "Open Design"` now hits only the strategy docs that *state the
  correction*.
- **Decisions:** Open Design = inspiration only (stated verbatim in the doc); rendering staged
  A→B→C with sandbox/CSP/no-token rules fixed before any generated HTML ships; Electron
  recommended for W1 because the Node + better-sqlite3 daemon ships unchanged.
- **Research used:** WebSearch (Tauri vs Electron 2026 — native modules, sidecar tradeoff,
  updater signing). Earlier-session research (MCP registry, Linear delegation, agent-UX control
  surfaces, local-first wave) already cited in project-companion-roadmap.md.

## Phase 3 — Native Interactive Surface (`5f52839`, part 1)
- **Shipped:** Stage A exactly as specced — `apps/web/src/surface.ts` (typed `ArtifactSpec`
  union: `brief-summary`, `milestone-board`; pure `buildSurfaceArtifacts` over real
  brief/milestones/tasks with provenance + open-task counts) and a Surface panel with premium
  artifact cards (gradient-border treatment, kind chips, RTL-safe, board rows with status
  accents). **Empty project = empty surface** with an honest explainer; zero sample data; no
  generated code executes (Stage B/C deferred per the security plan).
- **Tests:** `apps/web/test/surface.test.ts` — empty-honesty, brief mapping + provenance,
  open-task counting (done/dropped excluded, unassigned counted), determinism.
- **Limitations:** artifacts are derived live, not persisted (the `artifacts` table is the
  Stage-B seam); no approval states yet; two kinds only — deliberate.

## Phase 4 — Provider/model/coding-runtime control (`5f52839`, part 2)
- **Shipped:** project-scoped role bindings — `roleSettingKey(role, projectId?)` centralizes the
  settings-key scheme; `resolveRole(role, projectId?)` resolves **project > global > auto** and
  reports `via`; chat turns resolve through the conversation's project; `providers.roles
  {projectId?}` returns both scopes + effective model; `amrita role set/clear --project`;
  the web provider card shows the live `fast/main/deep → provider (model) [scope]` line for the
  open project. Lane/task + session scopes are additive keys on the same resolver (documented).
- **Tests:** daemon (project beats global, other-project isolation, turn uses override,
  clear-falls-back, RPC scope reporting) + CLI round-trip. No secrets anywhere — bindings are
  provider *names*.
- **Limitations:** no Settings *page* yet (visibility line only — the typed foundation the
  polished screen will consume); CodingAgentBridge remains a documented contract (today's lane
  runner is its de-facto first implementation); no Hermes bridge exists in this repo —
  documented as discovery-based future category, not assumed.

## Phase 5 — Windows installer/update path (in Phase-2 commit)
- Doc shipped (see Phase 2). **No scaffold**: adding electron/electron-builder deps now would
  be junk weight with no tested build behind it — deferred to the W1 phase by design. Nothing
  is claimed as working.

## Phase 6 — Self-maintenance/rules
- **Files:** `.claude/rules/amrita-product-direction.md`, `.claude/rules/amrita-quality-bar.md`
  (stable truths only), CLAUDE.md "Product direction (v3 north star)" section pointing at them.
- **Boundaries honored:** rules carry no task progress (that's this ledger), no secrets, and
  are committed separately and reversibly.

## Phase 7 — Hardening/final verification
- **Cleanup review (touched files):** no TODO/FIXME/console.log in source; all new exports
  consumed (`surface.ts` ← App + tests; `roleSettingKey` ← kernel); no temp/report files; no
  debug UI; names consistent (role scopes, artifact kinds) across daemon/CLI/web/docs.
- **Debt recorded (not silently ignored):** `App.tsx` ~1500 lines — split into components in a
  deliberate refactor phase (recommendation: when the Settings page lands); in-tx spill
  (ADR-0006 note) unchanged; `scope.network` still advisory (honest in ADR-0015).
- **Gates:** root typecheck/lint/test ✓ (229), web typecheck/test/build ✓ (final numbers in the
  session report). Secret scan: only the two clearly-labeled fake scrubber fixtures in
  `packages/lanes/test/lanes.test.ts`. Live smoke: companion loop over real HTTP daemon
  (health/401/brief/evidence-enforcement/risk/milestone/timeline) executed this session; roles
  + surface verified through unit/CLI layers.
- **Push:** attempted; sandbox has denied `git push` in all prior sessions — exact command for
  Boni recorded in the session report if it repeats. (Boni pushed successfully and verified
  `7f6e615` == origin/v2-main.)

## Phase 8 — Settings & Runtime Hub / Surface Stage B prep
- **Start commit:** `7f6e615` (== origin/v2-main, clean tree, all gates green: 229 root / 43
  web at start).
- **Scope:** the next-phase directive — App split, runtime-selection contract (ADR-0019),
  Settings & Runtime Hub, memory/session invariance proofs, Stage-B sandbox harness,
  lane-receipt artifact, CLI parity.
- **Reality inspection:** no dirty state; no failures; debt list from Phase 7 confirmed
  current (App.tsx split was the top item — paid this phase).
- **Files changed:**
  - split (`df9fa72`): `src/components/{NextActionsPanel,RuntimePanel,SurfacePanel,
    TimelinePanel,LanesPanel}.tsx`, `src/client.ts` singleton, doctor types → `api.ts`;
    App.tsx ~1500→~1190 lines, behavior preserved (43→44 web tests green through the split);
    `lane-receipt` Stage-A artifact added with tests.
  - backend (`540f1d9`): ADR-0019; `src/runtimes.ts` (bounded no-shell probes, injectable
    prober, 5 honest states); `runtime.status` + `providers.role.set/clear` RPC (single
    validated write path; CLI switched off raw settings keys); kernel `systemWriteContext`;
    `model.request.via` provenance (protocol change per ADR); `amrita runtime status`.
  - hub (`e063068`): `SettingsRuntimeHub.tsx` + topbar Project/Settings toggle; typed
    `runtimeStatus/roleSet/roleClear` wrappers + tests; hub CSS (stacked cards, mobile-safe).
  - invariance + harness (`5c09aaf`): `test/invariance.test.ts` (8 invariants from the
    directive proven); `src/sandbox.ts` + tests (Stage-B contract shipped before any preview
    UI exists).
- **Runtime architecture decisions:** one resolver, no vendor specials; brain ⊥ execution
  (coding-runtime card independent of brain bindings); probe-or-unknown honesty; official
  routes only (no "Claude Max API", no scraping — ADR-0019 §8); `via` provenance on every turn.
- **Memory/session invariance checks:** same conversation across switch ✓ · state intact ✓ ·
  new turn uses new resolution ✓ · old turns keep original provenance ✓ · timeline spans both ✓
  · no hidden provider state needed ✓ · no cross-project leak ✓ · clear falls back without
  deleting ✓.
- **UI behavior:** Hub honest by construction (probed states, future-labeled categories, no
  green without proof); brain copy states the invariance promise; mobile reflow inherited.
- **Tests/gates:** final counts in the session report; all green before push attempt. CLI
  `runtime status` has no CLI-layer test by design — the default prober would probe the real
  machine (nondeterministic); the logic is covered at the daemon layer with injected probers.
- **Live smoke:** real daemon on temp DB — health 200 public, RPC-no-token 401, turn 1
  `mock/mock-default`, Hub-path `providers.role.set` (project), turn 2 in the SAME conversation
  `mock/brain-b`, brief intact, provenance `[(mock-default,auto),(brain-b,project)]`,
  `runtime.status` reports `main → mock brain-b [project]` and a REAL Claude Code probe
  (`ready`, v2.1.173) on this machine.
- **Browser QA (Playwright, real Vite dev + daemon):** port 5173 found occupied by an unrelated
  app (Boni's Live Voice — left untouched); Amrita served on 5174. Verified: shell renders,
  token save clears 401s, Settings toggle swaps the inspector to the Hub, role-set round-trips
  live (`main → mock (qa-brain) [binding]`), Claude Code card shows the real probe, console
  clean except pre-auth 401s + favicon 404 (cosmetic, pre-existing). **Found and fixed a real
  mobile defect** (`4b01eb6`): 497px card tracks in a 390px viewport — grid tracks now
  `minmax(0,1fr)`, items `min-width:0`, topbar wraps; re-verified at 390×844. QA servers/db/
  snapshots cleaned up afterwards.
- **Limitations:** review/QA/planning runtime roles are documented-reserved, not selectable;
  no lane/task/session scope keys yet (same resolver, additive); no preview renderer (harness
  only, by design); brand memory B1 deferred → next phase; Hermes bridge remains
  discovery-based future.
- **Next phase:** Brand memory B1 + first sandboxed `html-preview` behind an approval state +
  knowledge-panel componentization (the remaining App.tsx debt).

## Phase 9 — Brand Memory B1 / sandboxed html-preview / panel extraction
- **Start commit:** `4d2b44e` (== origin/v2-main after Boni's push; clean tree; gates green
  235 root / 49 web at start).
- **Scope:** the next-phase directive — brand memory B1, first sandboxed `html-preview` behind
  a durable approval flow, and the remaining App.tsx knowledge-panel extraction.
- **Reality inspection:** no dirty state, no failures, Phase-8 debt list current (knowledge
  panels in App were the top item — paid this phase).
- **Files changed:**
  - store (`c4fdce9`): ADR-0020; migration `0005_brand_previews` (schema v5) — `project_brands`
    full-document rows + `preview_approvals` (project, previewId) PK; `brand.updated` (refine:
    ≥1 substantive field — empty brand is rejected, not stored) + `preview.approved` events;
    store APIs/projections/schema mirrors; tests incl. cross-project isolation and re-approval
    drift; version-sensitive assertions bumped.
  - runtime (`cc6aedf`): companion.get gains `brand` + `previewApprovals`;
    `projects.brand.update` + `projects.previews.approve`; `amrita brand get/set`; daemon/CLI
    tests.
  - web (`d4ca2c8`): deterministic project-cover preview (brief+brand+plan; palette hex →
    accent; HTML-escaped; brand-less = labeled "neutral preview"), FNV-1a content hash,
    proposed→approved lifecycle rendered ONLY through the sandbox harness (allow-scripts only,
    zero-network CSP); BrandPanel; **all** knowledge panels extracted
    (Brief/Brand/Memory/Tasks/Decisions/Questions+Risks via one SettleListPanel/Milestones);
    App.tsx ~1190 → ~650 lines; surface/api tests for derivation, approval, drift-demotion,
    escaping.
- **Approval-lifecycle decision:** previews are pure functions of typed state, so the HTML is
  never persisted — the durable thing is the approval of an exact content hash; drift demotes
  honestly. "Draft" = editing brief/brand (documented equivalent).
- **Honesty checks:** no auto-approval; neutral previews labeled; empty brand rejected at the
  protocol; approvals project-scoped by PK.
- **Tests/gates + QA:** final counts and browser QA results in the session report.
- **Limitations:** single preview template per project (id scheme permits more later); no
  preview revocation UI (re-approval covers it; `preview.revoked` is additive); LLM-generated
  previews deferred (deterministic template is the v1 generator); brand asset uploads (logo
  files) deferred.
- **Next phase:** operator mode (Telegram runner + approval.* plumbing) or Settings-Hub
  expansion per the roadmap; see session report recommendation.

## Phase 10 — Operator Mode (approvals + Telegram runner)
- **Start commit:** `fb586f5` (== origin/v2-main after Boni's push; clean; 240 root / 52 web
  green at start).
- **Scope:** roadmap item 1 of the continue-directive — approval plumbing through lanes,
  Telegram operator commands + live runner, web approvals panel. ADR-0021.
- **Shipped:**
  - `063b9c6` — kernel approval broker (`requestApproval`/`resolveApproval`/
    `listPendingApprovals`, timeout→DENY default 120s, signal-aware, audit via approval.*
    events); REAL lane runs under the default 'forward' policy now gate on a `lane.run-real`
    approval ('auto-safe'/'sandboxed' pre-authorize; safe/dry flows unchanged);
    `approvals.list/resolve` RPC; 6-scenario test suite (allow/deny/timeout/cancel/ungated/
    unknown-id).
  - `c81e7d8` — Telegram operator commands (/status /lanes /approvals /approve /deny /stop
    /help; project-scoped, prefix-matched, owner-gated) + the live long-poll runner
    (injectable fetch, official Bot API, token read once in-closure, refuses unconfigured,
    idle backoff); `amritad --telegram`; kernel channel-runner tracking so channels.list +
    doctor report telegram `ready` only while actually running; daemon⇄channels bin-only
    cycle documented in ADR-0021 §5.
  - web (this commit): `approvalsList/Resolve` wrappers, ApprovalsPanel (renders only when
    something is pending; live-stream refresh on approval.* events; project-scoped filter),
    Allow/Deny actions.
- **Honesty checks:** deny-by-default everywhere (timeout, empty allowlist, stranger gate);
  no fake telegram readiness; no secrets in replies/errors/tests (fake token fixture labeled).
- **Verification:** counts in the session report; live HTTP smoke proves the deny path
  end-to-end without executing anything real.
- **Limitations / next:** approvals panel not browser-verified this session (API/unit-level
  only — stated honestly); no CLI approvals commands yet (web+Telegram are the surfaces);
  approval notifications are pull/stream-based (no Telegram push on request — the runner
  could proactively notify owners: next slice); remaining roadmap items (Setup Hub manifests,
  research lanes, artifact library, GitHub import, tool registry, installer scaffold)
  untouched this session — next session should start at Setup Hub + GitHub one-way import.

## Phase 11 — Setup Hub connector manifests + GitHub one-way issue import

- **Date:** 2026-06-11 · **ADR:** 0022 · **Migration:** 0006_task_external_ref (schema v6)
- **What landed:**
  - `@amrita/protocol`: `connectorManifestSchema` (slug/kind/title/capabilities/requiredEnv
    NAMES-only/setupCommands/docsUrl), `connectorRuntimeStateSchema` (connected ·
    configured_but_failing · needs_setup · needs_install · status_unknown · experimental),
    `connectorStatusReportSchema`; `task.created` gains optional `externalRef` + `body`
    (additive on strict — old events replay unchanged).
  - store: `tasks.external_ref` + partial UNIQUE `(project_id, external_ref)` — import
    idempotency is a DB guarantee; `createTask` provenance fields; `listTaskExternalRefs`.
  - daemon: code-registered manifest registry (GitHub first; channels deliberately stay in
    channels.list — one concept, one truth); `connectors.status` RPC with a live bounded
    `/rate_limit` probe through the kernel's injected fetch — `connected` is impossible
    without a probe; doctor `connectors` section (presence-only, says so); `github.ts`
    adapter (official REST, PRs excluded, token read at call time, value-free GithubError →
    structured RPC codes); kernel `importGithubIssues` (skip-existing idempotency,
    `github:owner/repo#N` provenance, issue URL in body).
  - CLI: `connectors status`, `github import --project --repo [--state] [--limit]`.
  - web: Setup Hub connectors card (live states, exact export commands, inline one-way
    GitHub import that refreshes Tasks), `connectorsStatus`/`githubImport` wrappers
    (channel: web provenance).
- **Honesty checks:** no fake green (connected ⇔ live probe ok; inconclusive = status
  unknown); env NAMES only end-to-end (schema-enforced in the manifest itself); import is
  one-way — Amrita never writes to GitHub; missing token errors name `GITHUB_TOKEN`, never a
  value; tests use injected fetch + labeled fake token, zero real network.
- **Verification:** full gates + web build in the session report; CLI e2e covers the
  no-token path without network.
- **Limitations / next:** re-import skips changed issues (no title sync — future refresh
  semantics); no `connector.installed` store rows used yet (reserved for user-installed
  connectors); Setup Hub card not browser-click verified this session; research-lane seam +
  artifact library are the next roadmap slices.

## Phase 11e (stretch) — research-lane seam + lane-kind routing

- **Date:** 2026-06-11 · **ADR:** 0023 · no protocol/store change
- **What landed:** kernel dispatches lanes by `kind` (`extraLaneRunners` on KernelOptions);
  unknown kinds abort honestly instead of silently running the Claude Code runner (an
  intentional, documented behavior change); `ResearchLaneRunner` (kind `research`) behind the
  same LaneRunner contract with an injected `ResearchSearchProvider` seam — unwired it aborts
  with a needs-setup summary; with a provider it reports sources as merge-report follow-ups
  (empty result = honest `partial`; provider failure = value-free abort; cooperative cancel).
- **Honesty checks:** no search provider ships and nothing claims research capability; the
  default-kind path is regression-tested (Phase 10 approval gate untouched — it sits above
  the runner seam).
- **Verification:** lanes 32/32 and daemon lane routing tests in the session report.
- **Limitations / next:** wire a real search provider as an ADR-0022 connector manifest +
  provider implementation; artifact-library groundwork did NOT naturally fall out of this
  phase and remains untouched (next roadmap slice).
