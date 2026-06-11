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
  Boni recorded in the session report if it repeats.
