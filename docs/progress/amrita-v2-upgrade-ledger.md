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

## Phase 11f — release lock: review fixes + browser QA (pre-push)

- **Date:** 2026-06-11 · amends ADR-0021 §2
- **Review fixes:** (1) approval-gate bypass closed — on an opted-in daemon the runner
  executes for real regardless of the caller's `real` flag, so the gate now keys on daemon
  posture: EVERY non-dry run under `forward` policy is gated (regression test added);
  (2) telegram runner `stop()` now aborts the in-flight long-poll (was: up to 25 s shutdown
  hang) and a failing `handleUpdate` no longer drops the rest of the batch; (3) the GitHub
  probe timer is cleared after a fast probe (a claimed unhandled-rejection crash was refuted
  empirically — `Promise.race` subscribes to both promises).
- **Browser QA (Playwright, temp DB):** ApprovalsPanel verified live — real-flag start and
  non-real start on an opted-in daemon both raise `lane.run-real`; Deny dismisses the card
  and the lane shows `exit aborted · real run denied by operator` (runner never invoked).
  Setup Hub verified — GitHub card shows `needs setup` with the missing env NAME and exact
  export command when the daemon has no token. Allow path remains unit-test-covered only
  (allowing in the browser would launch a real Claude Code run).

## Phase 12 — first-run onboarding: installer + setup wizard (ADR-0024)

- **Date:** 2026-06-12 · ADR-0024
- **Why:** fresh-install QA showed a working build but an unacceptable path to a usable
  Amrita (SSH, hand-edited env files, four CLI calls, mandatory `--db`). Benchmarked against
  Hermes Agent's installer (`/usr/local/lib/hermes-agent`, read-only) and Amrita v0.1's
  `install.sh` + sectioned `amrita setup`; adopted their proven shape on v2's existing seams.
- **What landed:** `~/.amrita` home helpers in `@amrita/daemon` (`home.ts`: default DB path,
  `secrets.env` parse/load/write — atomic, 0600, names-validated, process-env-wins);
  both executables load the secrets file at the process boundary only (in-process `run()`
  never does — tests stay hermetic); `--db` optional everywhere (defaults to the home DB;
  `amritad` no longer defaults to `:memory:`); new `amrita setup` wizard (provider key with
  no-echo paste → account connect/bind/role via the same RPC as the individual commands →
  telegram with LIVE getMe verification, injectable fetch → doctor summary; idempotent,
  non-TTY refuses with exact equivalent commands); doctor fixes now lead with `amrita setup`
  and drop the `--db` noise; `scripts/install.sh` one-liner (prereqs, clone-or-ff,
  frozen-lockfile install, `~/.local/bin` launchers, opt-in systemd user service from
  `deploy/amritad.service`).
- **Honesty checks:** wizard re-probes provider availability after binding and reports the
  truth; failing telegram tokens are reported and saved only on explicit confirmation; the
  installer never collects secrets (Hermes lesson: defer to setup); store still holds env
  NAMES only.
- **Verification:** 13 new tests (8 home, 5 wizard) + 2 updated (doctor fix text, optional
  `--db`); full suite green; `bash -n` on the installer; manual end-to-end below.
- **Limitations / next:** installer untested on macOS; Windows remains the W1 Electron
  track; wizard is English-only (web surface owns i18n); no `amrita update`/uninstall yet.

## Phase 12a — first-run hardening after laptop QA

- **Date:** 2026-06-12 (evening) · amends ADR-0024
- **Found in live WSL QA:** a first run that races another process (e.g. `amrita health`
  next to `amritad`) could die with `SqliteError: table messages already exists`, and DB
  open failures printed a raw stack trace in violation of the value-free-errors bar.
- **What landed:** `migrateUp` takes the write lock up front (`BEGIN IMMEDIATE` — the
  Hermes lesson already recorded in docs/hermes-architecture-notes.md) and re-checks the
  applied-set INSIDE the transaction, so a racing migrator skips cleanly; both `amrita`
  and `amritad` wrap kernel open in a structured `store_open_failed` error (CLI adds a
  delete-and-re-run hint for partially-migrated files; no stack frames).
- **Verification:** 3 new tests (2 migrate-concurrency, 1 poisoned-DB structured error);
  suite 294/294. `better-sqlite3` (+types) added as @amrita/cli devDependency for the
  poisoned-DB fixture.

## Phase 13 — Hermes-grade provider catalog: subscription login, 7 brains, honest chooser (ADR-0025)

- **Date:** 2026-06-12/13 · ADR-0025
- **The miss it fixes:** the Phase 12 wizard shipped API-key-only with two providers —
  an incomplete implementation, not a technical limit (protocol's authMode enum, the
  CommandProber seam, and accounts/settings were already designed for more). Natanel's
  expectation was the v0.1/Hermes chooser breadth; this phase delivers it on v2 seams.
- **What landed:** `REAL_PROVIDERS` became a render-from-metadata catalog (title/group/
  authMode/envName/keyUrl/baseUrl/detectCli/executable); ONE OpenAI-compatible adapter
  with version-segment baseUrls powers openai + OpenRouter + Gemini-compat + local
  endpoints; `claude-code` chats through the logged-in Claude Code CLI (`claude -p
  --output-format json`, injectable CliExec, classified value-free errors) — a real
  subscription path with zero keys; `codex` ships detection-only and SAYS so (never
  faked); local endpoint config `{baseUrl, model, keyEnv?}` persists in settings under
  `providers.endpoint.local`; new async `providers.catalog` RPC with bounded live CLI
  probes (10s catalog budget after measuring `claude auth status` ≈ 4s — a slow honest
  state beats a fast wrong one); wizard renders the grouped catalog with state marks,
  recommended default, back/retry loop, optional model override, and re-run-to-switch;
  doctor collapses an unconfigured brain into one summary warn.
- **Verification:** 24 new/rewritten tests (12 catalog/chat: states per probe scenario,
  URL assertions for openrouter/gemini/local, CLI exec success + logged-out classify,
  codex refusal; 12 wizard: all groups rendered, subscription ready/logged-out flows,
  codex→OpenRouter fallback, local persistence, invalid-input retry, brain switching);
  suite 313/313; LIVE smoke on the VPS: real wizard run showed claude-code "logged in
  (2.1.175)" via real probes and one Enter bound it; `amrita chat` then answered through
  the actual subscription (`claude-code · sonnet`). Also moved `onlyBuiltDependencies`
  to pnpm-workspace.yaml (pnpm 11 ignored the package.json field with the WARN seen in
  laptop QA).
- **Limitations / next:** codex execution deferred until its CLI contract can be
  verified on a machine that has it; streaming still honestly `false` for real
  adapters; web Setup Hub still renders the old provider list — pointing it at
  `providers.catalog` is the next slice; xAI/Mistral/etc. are now one catalog entry each.

## Phase 14 — Hermes-grade setup / providers / runtimes / doctor (ADR-0026)

- **Date:** 2026-06-13 · ADR-0026 · study: docs/strategy/hermes-install-architecture-study.md
- **Why:** after a deep read of Hermes' install/setup/provider/auth/doctor architecture
  (file:line citations in the study doc), Amrita's onboarding was still shallow on sectioned
  setup, a shared model command, provider transport/alias/discovery depth, a typed config +
  backup + permission layer, a generalized runtime registry, and a grouped doctor.
- **What landed:**
  - **home.ts:** typed `~/.amrita/config.json` (atomic 0600), `backupBeforeReconfigure`,
    `checkPermissions`/`fixPermissions` (home 0700, secret/config 0600).
  - **provider.ts:** `transport` + `baseUrlEnvVar` + curated `models` + `supportsModelDiscovery`
    on every spec; `PROVIDER_ALIASES`/`normalizeProvider` (claude→anthropic, ollama→local…);
    `probeOpenAiModels` + `suggestV1BaseUrl`; `findProviderSpec`. Kernel honors base-URL env
    overrides and alias-normalizes role bindings + chat resolution.
  - **runtimes.ts:** `CODING_RUNTIMES` registry + `getRuntimesStatus` (claude-code wired;
    codex/opencode detection-only, honest).
  - **kernel/rpc:** `discoverModels` (live /models → curated fallback) + `probeEndpoint`
    (custom-endpoint /v1 hint + /models) behind `providers.models` / `providers.probeEndpoint`.
  - **setup.ts:** `SETUP_SECTIONS` (brain/roles/runtime/channels/service/agent/tools); first-run
    quick vs `--full` reconfigure (with backup) vs `amrita setup <section>`; `amrita model`
    shared brain flow; section-aware non-interactive guidance; local-endpoint section probes
    /models and picks a discovered model; agent section opts into real lane execution.
  - **doctor.ts:** async + grouped home→store→providers→runtimes→lanes→channels→connectors→auth;
    permission failures with `amrita doctor --fix`; runtime live states.
  - **commands.ts:** `amrita model`, `amrita setup <section>/--full`, `amrita doctor --fix`,
    `amrita provider catalog`, `amrita provider models <id>`.
  - **install.sh:** launcher backup before overwrite + post-install `amrita health` verification.
- **Honesty checks:** secrets stay env-NAMES-in-store / values-in-secrets.env; codex stays
  detection-only; mock fallback preserved; doctor never prints a secret; live probes are bounded.
- **Verification:** 342/342 tests (29 new across home/provider-registry/doctor/setup); typecheck
  + lint clean; `bash -n` on the installer; live VPS smoke of `amrita doctor`, `amrita provider
  catalog`, and `amrita provider models`.
- **Intentionally deferred:** models.dev live catalog ingestion; credential pool/rotation +
  codex OAuth execution (seams only); cross-init service abstraction; web Setup Hub → catalog.

## Phase 15 — parity map + web Setup Hub consumes providers.catalog

- **Date:** 2026-06-16 · doc: `docs/strategy/hermes-parity-roadmap.md` · amends ADR-0026
- **Why:** ADR-0026's stated next slice was "point the web Setup Hub at `providers.catalog`" — the
  Hub still derived provider truth from the simpler `runtime.status` `providers` list (a flat
  available/unavailable), not the live-probed honest-state catalog the CLI wizard and
  `amrita provider catalog` already render. Also needed: a living, repo-grounded Hermes↔Amrita
  parity map so future slices are tied to concrete surfaces, not abstract goals.
- **What landed (web only — no protocol/store/daemon change):**
  - `docs/strategy/hermes-parity-roadmap.md` — the living parity matrix across
    install/setup/config/auth/providers/daemon/gateway/memory/connectors/cron/doctor/web/docs,
    each row as Hermes capability → Amrita current → gap → target → slice → verification gate,
    with a sequenced next-slice list (B done here; C README, D config CLI, E doctor groups,
    I service/update, F/G/H/J ADR-gated).
  - `apps/web/src/api.ts` — `ProviderCatalogEntryLite` (mirrors the daemon's `ProviderCatalogEntry`:
    id/title/group/authMode/defaultModel/executable/envName?/keyUrl?/installHint?/state/detail/fix?)
    + `providersCatalog()` wrapper over the existing `providers.catalog` RPC.
  - `apps/web/src/providers-view.ts` (new, pure) — `CATALOG_STATE_LABEL`, `CATALOG_GROUP_LABEL`,
    `catalogBadgeClass` (only `ready` → ok/green; operator-action states → warn;
    missing_cli/unavailable → off), `catalogStateHint` (fix → installHint → `amrita setup`),
    `groupCatalog` (render order login→api_key→local, empty groups dropped), `catalogOptionLabel`.
  - `apps/web/src/components/SettingsRuntimeHub.tsx` — fetches the catalog on refresh; new
    "Brain providers — catalog" card (grouped, honest badges, default model + key env NAME, detail,
    fix command); role dropdowns now label each provider with its honest state
    (`anthropic — needs key`, `codex — missing CLI`, `claude-code` when ready); removed the
    hand-derived "API providers / Subscription connectors" summary (now points at the catalog card).
  - `apps/web/src/styles.css` — `.hub-catalog-group` / `.hub-catalog-title`.
- **Honesty checks:** `ready` is impossible without the daemon's real probe (env presence / live
  CLI login / endpoint config); the card shows env-var NAMES only, never a value; no fake green.
- **Verification:** web typecheck ✓ · web test 59/59 (10 files; +6: 1 api wrapper, 5
  providers-view) ✓ · web build ✓ · root typecheck/lint/test 342/342 ✓ · live browser smoke
  (Playwright on a real `amritad --http` + Vite, temp DB): Hub renders the catalog card with
  Claude Code **ready** via a real 2.1.175 probe, codex **missing CLI** (+install hint), the four
  API keys **needs key** (+`amrita setup`), local **needs endpoint**; dropdowns carry the same
  honest labels; no secret value anywhere. Smoke servers/db/artifacts cleaned up afterwards.
- **Limitations / next:** the chat **topbar** provider select (App.tsx, separate from the Hub)
  still shows the simpler `(unavailable)` suffix — could adopt the same catalog labels next; the
  `providers.probeEndpoint` RPC is not yet surfaced as a Hub input (local-endpoint probe-and-pick);
  parity roadmap items C (README), D (`amrita config`), E (doctor memory/service/daemon groups),
  and I (`amrita service/update/uninstall`) are the sequenced next slices.

## Phase 16 — `amrita config` CLI + README reality alignment

- **Date:** 2026-06-16 · parity-roadmap Phases C + D · no protocol/store/daemon change
- **Why:** Hermes has a real `config` command layer; Amrita had a typed `config.json` + helpers in
  `home.ts` but **no `amrita config` verb**. And the README still called Telegram a "skeleton …
  live bot runner not bundled yet" (false since Phase 10's operator runner), carried a stale
  "Phases 0–5" status header, and documented neither data locations nor the config command.
- **What landed (CLI + docs only):**
  - `packages/cli/src/config-cli.ts` (new) — `configPath` / `configShow` / `configSet` /
    `configCheck` over the daemon home helpers, plus exported pure guards `isSecretLikeKey`
    (key substrings: secret/token/password/apikey/credential/bearer/…), `looksLikeSecretValue`
    (OpenAI/GitHub/Slack/AWS/Google/bearer token shapes — defense-in-depth so a benign key can't
    smuggle a value), and `parseConfigValue` (bool/number/string coercion). `config set` refuses
    secret-like keys **and** secret-shaped values with a value-free message pointing at
    `secrets.env` / `amrita setup`, and backs up `config.json`+`secrets.env` before overwriting an
    existing key.
  - `packages/cli/src/commands.ts` — `config path`/`config show`/`config set`/`config check`
    entries in the `COMMANDS` registry (pure file ops; no kernel needed).
  - `README.md` — status header de-staled; daemon bullet now describes the provider catalog +
    runtime registry + grouped doctor; CLI bullet lists setup/model/config/doctor/provider/runtime/
    connectors; channels bullet describes the **live** Telegram operator runner + commands;
    Quick Start adds the expected-pre-setup-warnings note, a data-locations table
    (`amrita.db`/`secrets.env`/`config.json`), the `amrita config` pointer, and the dev daemon
    bearer-token note; links the upgrade ledger + parity roadmap.
  - `docs/strategy/hermes-parity-roadmap.md` — Config-CLI + README rows marked done; sequenced
    next-slice list updated (B/C/D done; E next).
- **Honesty checks:** secret VALUES still never enter config.json/store/logs/errors — the refusal
  paths never echo the offending value (test-asserted); `config set` only writes
  `AmritaConfig.preferences`; README claims were read back against the actual code/runner.
- **Verification:** root typecheck ✓ · lint ✓ (biome, after formatter) · root test **351/351**
  (25 files; +9: 5 `cli.test` config flows incl. secret-key & secret-value refusals + json
  round-trip, 4 `config-cli` guard units) · manual CLI smoke on an isolated `AMRITA_HOME`
  (`config path` lists all four paths; `config set theme dark` types & persists; `OPENAI_API_KEY`
  refused with a value-free message exit 2; `config show`/`config check` ok).
- **Limitations / next:** `config set` writes flat `preferences.<key>` only (no dotted nesting);
  `config edit`/`config migrate` not built (schema v1, nothing to migrate — not faked); Phase E
  (doctor `memory`/`service`/`daemon-token` groups) and Phase I (`amrita service`/`update`/
  `uninstall`) are the next sequenced slices.

## Phase 17 — Organizational Brain Harness (engineered knowledge layer)

- **Date:** 2026-06-17 · ADR-0027 · strategy: `docs/strategy/organizational-brain-harness.md`
- **Why:** "organizational brain" must mean an **engineered agentic knowledge harness** — not
  generic RAG, not an Obsidian graph picture, not a passive vault. Retrieval is a tool; the harness
  (agents that ingest → normalize → link → maintain knowledge with provenance and honest gaps) is
  the product. This integrates the remaining roadmap **Phase G** (memory architecture) and frames
  **H** (sources/connectors) and **F** (channels as sources).
- **Design choice (honest, reversible):** the brain is a **deterministic projection** over existing
  event-sourced state + manually-captured memory (same pattern as `surface.ts`) — **no new store
  table**. A dedicated `knowledge_records` table + `harness.*` events are deferred to when a real
  automatic ingestion connector lands (documented migration path in ADR-0027).
- **What landed:**
  - `@amrita/protocol` `harness.ts` (+index, +tests) — view/spec schemas: `knowledgeRecord`
    (7 kinds, provenance, owner/date/confidence/tags/links/status), `knowledgeSource`
    (honest `connected|manual|planned`), `knowledgeGap` (7 kinds), `harnessTopology`
    (agents-as-code), `maintenanceEvent`, `projectBrain`.
  - `@amrita/store` — `listMemoryEntries(projectId)` read (no migration).
  - `@amrita/daemon` `harness.ts` (+tests) — honest `HARNESS_TOPOLOGY` (capture/linker/maintainer
    active; chat/mailbox extraction + answer-agent planned), `baseKnowledgeSources()`, and the pure
    `buildProjectBrain` projection (maps brief/decisions/questions/risks/milestones/external-tasks/
    memory → records with provenance + `[[links]]`; computes gaps: missing-owner/date/source,
    orphan, unresolved-question, stale, contradiction; derives a maintenance timeline from the event
    log) + `renderRecordMarkdown`. Kernel: `harnessTopology` / `listKnowledgeSources`
    (enriches chat from the live Telegram runner) / `getProjectBrain` / `captureKnowledge`
    (manual capture via the value-free memory path). RPC: `harness.topology|sources|brain|capture`.
  - `@amrita/web` — `api.ts` types+wrappers; `harness-view.ts` pure helpers (honest source badges —
    only `connected` is green; record grouping; provenance/link labels); `BrainPanel.tsx`
    (explainer distinguishing RAG vs graph vs harness; ingestion lanes with honest status + exact
    next step; manual-capture box; records grouped by kind with provenance, owner/date, tags, and
    resolved links; gaps; maintenance timeline; topology); tri-state inspector toggle
    Project/Brain/Settings in `App.tsx`; CSS.
- **Honesty checks:** no source is `connected` (email/calendar/docs/chat = planned; repo/manual =
  manual); the UI states retrieval ≠ maintained knowledge and graph = optional output; provenance
  carries source ids/refs only, never a secret; manual capture goes through the value-free memory
  path; empty project = empty brain (no sample data).
- **Verification:** root typecheck ✓ · lint ✓ · root test **362/362** (27 files; +11: 5 protocol
  harness, 6 daemon harness) · web typecheck ✓ · web test **64** (+5: 1 api wrapper, 4 harness-view)
  · web build ✓. **Live browser smoke** (Playwright on real `amritad --http` + Vite, temp DB):
  seeded a question + decision → Brain view rendered them as linked records (decision↔question,
  bidirectional, provenance `manual`), an `unresolved-question` gap, and a maintenance timeline;
  **manual capture** of a commitment via the UI created a `commitment` record (owner `nethanel`,
  provenance `manual:brain`) and the maintainer surfaced honest `missing-date` + `orphan` gaps.
  Smoke servers/db/artifacts cleaned up.
- **Limitations / next:** projection (not persisted) records — dedicated `knowledge_records` table
  + `harness.*` events land with the first automatic ingestion connector; email/calendar/chat/docs
  extraction agents are `planned`; the brain-cited answer-agent (Ask-Amrita-from-the-brain with
  citations) is `planned` — today's chat answers are not yet brain-cited; duplicate-merge and
  automated contradiction resolution beyond markers/superseded are future.

## Cinema stream — module federation (ADR-0028…0031) — BACKFILLED

- **Date range:** 2026-06-18…2026-07-06 · **Backfilled:** 2026-07-12 (audit finding G-2 —
  this stream shipped with receipts only in commit messages, violating the one-ledger rule;
  reconstructed here from commits `9a14f20`…`99ac653` and the four ADRs).
- **What landed (by commit):**
  - `9a14f20` ADR-0028 — cinema module contract: `protocol/src/cinema.ts` (delegated
    action/video-op verb subset, project digest with in-schema byte cap, mandate shapes);
    zod 3→4 upgrade; protocol became a buildable/packable package for the sibling repo.
  - `e54d616` — `cinema.chat` + `cinema.assetAnalysis` RPC verbs: thin authenticated proxy
    to the module brain (brain-bridge :8799); module stays payload authority.
  - `1361f2d` — cinema provider honesty merge: `cinema.providers` RPC + per-provider
    doctor rows computed from the bridge's own /health (no probe → no green).
  - `1698ebf` — cinema contract 0.1.1: batch-generate plan kind.
  - `9d91d71` — browser CORS (deny-by-default allowlist; local pages only by default) +
    Cinema module runbook (`docs/cinema-module.md`).
  - `644f127` ADR-0029 — cinema mandates: `module.mandate.issued/resolved` events,
    derived open/resolved projection, `cinema.mandate.*` RPC.
  - `ff498bc` ADR-0030 — cinema knowledge ingest: `module` source kind; cinema memory →
    `project-context` brain records; `cinema-extractor` agent active in the harness.
  - `99ac653` ADR-0031 — video-grounded audio authority Phase 0: `cinema-audio.ts`
    contracts (605 LOC) + tests; feature implementation explicitly blocked until fitness
    functions pass; execution stays in the sibling Aba Adama repo.
- **Lesson recorded:** phase-done now includes a ledger entry (reorganization checklist).

## R0 — Core closure: wire-contract jurisdiction + governance (ADR-0032)

- **Date:** 2026-07-12 · commits `6601326`/`3753709`/`fc601d2` · roadmap stage R0
- **What landed:** protocol/rpc.ts rewritten to the REAL transport (rpc envelopes, WS
  frame union incl. `replayed`, `rpcResultSchemas` covering every RPC method; dead
  ADR-0009 unions removed; protocol 0.4.0); shared enums exported and every inline copy
  deleted (roles ×15 → 1; task/auth/milestone/etc. via drizzle `columnEnum`); daemon
  dispatch parses+strips results on the way out; role-resolution builder deduplicated;
  apps/web depends on `@amrita/protocol` and parses envelope + per-method results + WS
  frames; `.claude/rules/` now tracked in git (G-1); spec authority banners (R-7);
  CLAUDE.md WIP hunk committed (G-3); local branch renamed `main` → `v2-main` (§6 hazard).
- **Fitness functions:** METHODS↔rpcResultSchemas exact-coverage test; full kernel
  round-trip contract test; enum-duplication grep clean.
- **Verification:** root 400/400 · web 65/65 · typecheck/lint clean · web build ok.

## R1 — Project Brain: compression, context probes, skill registry (ADR-0033/0034/0035)

- **Date:** 2026-07-12 · roadmap stage R1
- **What landed:**
  - **Compression-as-lineage (ADR-0033):** `conversation.compress` RPC + CLI; child
    conversation via existing `parent_id` with a deterministic digest `message.system`;
    parent gets `conversation.compressed` (new event) + `conversation.archived` (now
    projected — sets `archived_at`); refusals (`empty`, already-archived) map to RPC
    `conflict`; log stays append-only and replayable.
  - **Project context probes (ADR-0034):** `daemon/context.ts` — bounded read-only git
    probes (branch/dirty/ahead-behind/last commit via the injectable prober) + capped
    file summary; `projects.context` RPC; Brain view "Project context" card; `amrita
    context`. Honest needs-setup when no root. `knowledge_records` persistence stays
    deferred per ADR-0027 (no automatic external ingest yet — documented, not skipped).
  - **Skill registry (ADR-0035):** `protocol/skill.ts` manifest schema — registry entry,
    deny-by-default permissions, and usage docs are MANDATORY; tiers system (3 real
    code-registered skills over existing verbs) / shared (`~/.amrita/skills`) / project
    (`<root>/.amrita/skills`); unregistered/invalid/undocumented dirs are refused and
    reported; `skills.list` RPC, doctor `skills` section, `amrita skills`.
- **Verification:** root 408/408 (8 new R1 tests + wire round-trip extended) · web 65/65 ·
  typecheck/lint clean · web build ok.

## R2 — Channel & kernel hygiene (operator service, session-key, boundary parse)

- **Date:** 2026-07-12 · roadmap stage R2
- **What landed:**
  - **Operator-command service** (audit C-1/R-9): `/status /lanes /approvals /approve
    /deny /stop /help` moved from the Telegram adapter into `daemon/operator.ts` — ONE
    interpreter, channels only render; WhatsApp/terminal get identical answers for free.
    Also removes the adapter's `mandateJson` display parse (C-2).
  - **Session-key resolver** (Hermes lesson): `kernel.resolveChannelSession(channel,
    externalUserId)` — deterministic channel-identity → same store-backed conversation;
    a pairing without a conversation now gets the project `(default)` conversation
    instead of a dead end. One brain, formalized.
  - **External-boundary parse** (audit B-3): the Telegram runner parses Bot-API JSON
    with zod (`.loose()` per-update; a malformed update drops alone, the batch survives)
    — no more unchecked casts at the external boundary.
  - **Kernel split (partial, honest):** cinema mandates extracted to
    `daemon/cinema-mandates.ts` (named seam); kernel 2,290 → 2,047 lines. Config
    authority (audit E-1) verified already unified — `config-cli` consumes the home.ts
    read/write path; its secret-guard remains as intentional defense-in-depth (A-7).
    **Deferred with rationale:** approvals broker stays in-kernel (coupled to the
    pending-approvals runtime map); companion methods stay as the kernel facade (thin
    delegations); further decomposition rides with R3's system module.
- **Verification:** root 412/412 (4 new operator-service tests) · typecheck/lint clean ·
  channels suite green (telegram command parity unchanged).

## R3 — Global Amrita: system project, System Brain verbs, minimal scheduler (ADR-0036)

- **Date:** 2026-07-12 · roadmap stage R3
- **What landed:**
  - **Reserved system project** as the global scope (zero protocol break); global chat =
    the `(global)` conversation in it.
  - **System Brain verbs** (`daemon/system.ts` + RPC + wire schemas): `system.health`
    (doctor + per-project brain counts + scheduler heartbeat), `system.audit`
    (cross-project findings — missing brief / unresolved questions / open risks / brain
    gaps; `--record` captures the top findings into the system brain with
    `system:audit` provenance), `system.plan` (drafts into a target brain,
    `system:plan` provenance, never executes), `system.manage` (delegates a goal as a
    lane through the unchanged ADR-0015/0021 gates). CLI: `amrita system health/audit`.
  - **Minimal scheduler** (`daemon/scheduler.ts`, `amritad --scheduler`): typed jobs in
    settings (`scheduler.jobs`, zod-parsed, ≥5-min intervals), one shipped kind —
    `system-health` — silent on success, posts a `message.system` into the system
    conversation only on doctor FAIL (Hermes watchdog convention). Two-signal heartbeat
    (`lastTickAt` alive vs `lastSuccessAt` productive) surfaced in `system.health`.
    OS supervision stays systemd's job; the daemon never self-restarts.
  - Harness provenance passes `system:*` sources through exactly (records show honest
    `system:audit` / `system:plan` origins).
- **Verification:** root 419/419 (7 new system/scheduler tests; wire round-trip extended
  to the 4 new verbs) · typecheck/lint clean.

## R4 — Preview windows: the lane console + honest mode control

- **Date:** 2026-07-12 · roadmap stage R4 (no protocol/store change — rides the ADR-0014/
  0015/0021 lane + approval seams; the wire was already typed by ADR-0032)
- **What landed:**
  - **Lane console**: each lane card in the web app expands into a live console window —
    the full `lane.progress` stream (monospace, RTL-safe, bounded scroll), goal, status,
    merge summary, cancel. The console is a *view over the lane contract*, never a second
    execution path (master-plan conflict #5 honored).
  - **Mode control**: `ask` → mandate `approvals: 'forward'` (every real action gated by
    the operator broker — approve from web ApprovalsPanel or Telegram `/approve`);
    `auto` → `'auto-safe'` (pre-authorized within scope; daemon real-execution opt-in
    still required); **`plan` is listed but disabled with an honest "unsupported" label**
    — the Claude Code lane runner has no read-only planning flag yet, and per the product
    rule an unsupported mode is stated, never simulated. Mapping is a pure, tested
    function (`approvalsForMode`); a forced `plan` falls back to the GATED policy.
  - `approvals` policy now flows web → `lanes.start` (param existed since ADR-0021; the
    UI finally exposes it).
- **Remote note:** the browser already reaches the Hostinger daemon over the tokened
  HTTP/WS surface — the lane console IS the remote Claude window; CORS stays
  deny-by-default.
- **Verification:** web 66/66 (+1 mode-mapping test) · web build ok · root 419/419 ·
  typecheck/lint clean.

## R5 — Design Runtime: the first design ArtifactSpec (`design-page`)

- **Date:** 2026-07-12 · roadmap stage R5 (no protocol/store change — extends the
  ADR-0020 preview-approval seam and the Stage-B sandbox exactly as designed)
- **What landed:**
  - **`design-page` artifact**: a full brand-aware page design — header with brand
    identity, hero from the brief goal, scope cards, milestones strip — rendered by a
    deterministic renderer over typed state. Brand palette/typography tokens applied;
    brand-less projects say "neutral design", never an invented identity.
  - **Interactive, confined**: section navigation via a self-contained inline script;
    renders ONLY inside the Stage-B sandbox (allow-scripts, zero-network CSP,
    no-same-origin) — zero external references, everything escaped.
  - **Same approval lifecycle**: proposed → approved keyed to the exact content hash
    (`preview_approvals`, id `design-page:<projectId>`); any state drift demotes back
    to proposed. Never auto-approved.
  - Original system: the flyer-cookbook lesson (deterministic HTML/CSS typesetting)
    imported as METHOD; Open Design remains inspiration only. `design-animation` /
    `design-asset-board` kinds are the documented next steps, not stubs.
- **Verification:** web 70/70 (+4 design-runtime tests: brand tokens, interactivity,
  hostile-text escaping, hash lifecycle + drift, determinism) · web build ok · root
  419/419 · typecheck/lint clean.

## R6 — WhatsApp adapter, shared channel flow, terminal parity (ADR-0037, migration 0007)

- **Date:** 2026-07-12 · roadmap stage R6
- **What landed:**
  - **One shared chat-channel flow** (`channels/base.ts`): gate → pair → session
    resolution → operator commands → chat turn → chunked replies. Telegram now
    delegates to it; **no channel re-implements a single decision**.
  - **WhatsApp adapter** (`channels/whatsapp.ts`): official Cloud API surface only;
    deny-by-default string-id allowlist; full contract-test suite (deny / pair / chat /
    operator parity / unpaired guidance). **The live webhook runner is NOT bundled** —
    `channels.list` reports `needs_setup` with the exact env NAMES and states the gap.
    Nothing faked.
  - **`whatsapp` in the protocol channel enum** + **migration `0007_whatsapp_channel`**
    (the events-table CHECK is rebuilt; reversible down refuses if whatsapp rows exist).
  - **Terminal parity:** `operator.command` RPC + `amrita op '/status' --project <p>` —
    the same kernel interpreter as Telegram/WhatsApp, proven by a parity assertion.
  - **One-brain fitness test:** telegram + web turns land in the SAME conversation with
    per-channel provenance — the no-memory-duplication guarantee is executable.
- **Verification:** root 425/425 (6 new whatsapp/one-brain tests; migration up/down/up
  suite extended to 0007) · typecheck/lint clean.

## Release + deployment — v2.0.0-alpha.1 (E4 receipts)

- **Date:** 2026-07-12 · the closing loop of the reorganization directive
- **Verification loop (all fresh, this session):** root typecheck ✓ · lint ✓ · test
  **425/425** · web typecheck ✓ · test **70/70** · build ✓ · precise secret scan over the
  whole pushed range (only clearly-labeled test fixtures) · live smoke on a real daemon
  (temp DB): health/401/ping, mock chat turn, conversation.compress, projects.context
  (real git probe answered `v2-main · ahead 22`), skills.list, operator.command,
  system.audit --record, system.health with a live scheduler heartbeat.
- **Pushed:** `origin/v2-main` `3516f16` → `62accbc` (22 commits — everything from
  Phase 16 through R6). Tag **`v2.0.0-alpha.1`** created and pushed (first release
  anchor of the v2 line). `CHANGELOG.md` added (release receipts + rollback recipe).
- **Deployed (this host):** `scripts/install.sh` (fresh clone of the pushed remote →
  `~/.local/share/amrita-v2`, launchers verified) + system systemd unit `amritad`
  (`--http --telegram --scheduler`), enabled + active. `AMRITA_AUTH_TOKEN` written to
  `~/.amrita/secrets.env` (0600; value never printed). The real home DB migrated
  6 → 7 live on first open.
- **Live QA on the deployed daemon:** journal shows honest startup (telegram runner
  refused without its token — value-free; scheduler enabled; auth via env; lanes real
  exec disabled) · public /health ok (schema 7) · 401 without token · tokened ping ·
  system.health: doctor `warn` (honest fresh-setup state), scheduler running ·
  **two-signal heartbeat observed after the first tick: alive == productive, job
  outcome `ok`, and silent-on-success held (nothing posted)** · installed CLI answers
  (`amrita health`, `amrita skills`) · channels.list states are honest (web ready;
  telegram + whatsapp needs_setup with exact env names).
- **Still needing Natanel (not blockers):** provider key/login via `amrita setup` on the
  deployed home (doctor is `warn` until then); TELEGRAM_BOT_TOKEN + allowlist if the
  Telegram runner should go live; the dedicated-GitHub-repo question from the master
  plan's open items.

## Setup on the deployed host — brain connected (subscription, zero keys)

- **Date:** 2026-07-12 · non-interactive equivalents of `amrita setup` (the wizard's own
  guidance for non-TTY), run against the deployed home.
- **What happened:** `amrita provider catalog` showed `claude-code` **ready** via a real
  probe (logged in, 2.1.207); connected a `subscription_cli` account (no secret exists
  anywhere); bound `fast/main/deep → claude-code`.
- **Root cause found live:** the first real turn through the systemd daemon failed with
  an honest `provider_unavailable` — the service unit's default PATH cannot see the
  user-local `claude` binary. Fixed at both authorities: a PATH drop-in on this host's
  unit, AND the repo's `deploy/amritad.service` template + installer now substitute
  `__PATH__` (also added `--scheduler` to the template ExecStart). Future installs
  won't hit it.
- **E4 proof:** a REAL chat turn through the deployed daemon over RPC returned
  `provider: claude-code · model: sonnet` with a live subscription reply. Doctor:
  providers ✓ (account + role policy), runtimes ✓ (Claude Code authenticated) —
  overall `ok with warnings` (remaining warnings are honest optional-setup states:
  telegram token, cinema bridge token).

## Design overhaul — Claude design language, desktop + mobile (overnight directive)

- **Date:** 2026-07-12 (night) · commit `cd3b940` · directive: redesign everything to
  Claude's design standard incl. mobile, hunt design bugs, deploy.
- **Research:** Mobbin is login-walled (attempted, stated honestly) — so the tokens were
  extracted **live from claude.com's official CSS** via Playwright computed-style dump:
  the real warm-gray ramp (#faf9f5…#141413), clay #d97757/#c96442, Anthropic Serif
  display type, radii 4/8/12/16, expo-out motion. Recorded in `apps/web/DESIGN.md`
  (design source of truth, per the local Claude-Design guide's method).
- **What landed:** `styles.css` fully rewritten as a token system (light default + dark
  via prefers-color-scheme); Claude shell (ivory sidebar, paper 46rem chat column,
  serif hero, pill toggles, rounded composer with clay send arrow); chat turns styled
  Claude-style (user pampas bubbles pinned right, Amrita plain text with a stable-left
  अ avatar); every panel/badge/form restyled; mobile = Claude app patterns (overlay
  drawer + backdrop, bottom tabs Chat/Project/Brain/Settings, sticky safe-area
  composer, 44px targets). Class names unchanged — zero component-test churn.
- **Design-bug QA loop (real browser, live daemon):** found and fixed — RTL side-jumping
  of the avatar/user bubble (physical anchoring), topbar title selector broken by the
  new hamburger, drawer close behavior. Verified 1440 + 390×844 across all views;
  horizontal-scroll check programmatically false; console clean except pre-auth 401s.
- **Deployed:** pushed, deployed checkout ff'd + rebuilt, `amrita-web` restarted; public
  link re-verified desktop + mobile (screenshots).

## Session-OS + live canvas + first real build (directive round 3)

- **Date:** 2026-07-12 · commit `90f209b`
- **Mobbin:** login-walled (2 attempts, stated honestly) — grounding stayed the official
  claude.com token dump + firsthand claude.ai structure.
- **Sidebar bug root-caused:** clicks technically worked (measured 103–121ms to active)
  but gave ZERO immediate feedback and the IA hid the project↔chat relation — fixed at
  the source with optimistic selection + shimmer skeleton + the new IA, not a patch.
- **Project-owned sessions (claude.ai IA):** the sidebar is now a project tree — the
  active project expands its live sessions, `+ New session`, and an honest
  "N compressed into project memory" line. The global Conversations list is gone.
- **Session → memory layers (ADR-0033 amendment):** ending a session (⤓) compresses it;
  the digest now ALSO lands in `memory_entries` (source `session:compress:<id>`) and the
  Brain surfaces it with chat provenance. Verified live: memory.search finds the digest;
  the continuation session opens automatically.
- **Live canvas (Claude-Design style):** preview/design artifacts open beside the chat
  (desktop 2-pane; mobile full-screen overlay) with kind/status/Approve/close — same
  zero-network sandbox, re-derived live from typed state. Verified live on the public
  link, both viewports.
- **First real build receipt:** the pizzeria lane (approved by Natanel) produced
  `/root/amrita-workspaces/pizzeria/index.html` via real Claude Code execution with
  Write tools granted through the new `AMRITA_LANES_ALLOWED_TOOLS`; served at :7463.
- **Verification:** root 425/425 · web 74/74 · typecheck/lint clean · build ok · live
  browser QA on the public link (sessions tree, compress round-trip, canvas open/close,
  mobile overlay).

## Settings as a full claude.ai-style page (directive round 3 — completion)

- **Date:** 2026-07-12 · commit `c38a7c1` — closes the one item the previous entry left
  honest-open: Settings moved out of the inspector into the main column, claude.ai
  pattern: serif page title, LEFT SUB-NAVIGATION (Amrita brain / Providers / Coding
  runtimes / Connectors), one content pane per section; the desktop grid drops the
  inspector column while open; mobile renders the nav as pill chips on the Settings tab.
- **Verification:** web 74/74 · build ok · live QA on the public link: nav sections
  switch (screenshot desktop + providers + mobile), mobile horizontal scroll false.

## Async CLI exec — the daemon no longer freezes during chat turns

- **Date:** 2026-07-12 · commit `6086a1d` · trigger: Natanel hit
  `provider_unavailable: not found or timed out` mid-conversation.
- **Root cause (double):** (1) the claude-code adapter used `spawnSync`, blocking the
  ENTIRE Node event loop — RPC, WS stream, scheduler, approvals — for the full duration
  of every turn (the real source of every "Amrita stopped responding" impression);
  (2) the error message conflated a timeout with a missing CLI.
- **Fix at the source:** `defaultCliExec` is a real async `spawn` (fixed argv,
  `shell:false`, bounded, SIGKILL on timeout); `CliExec` accepts sync fakes so every
  existing test fixture stays valid. Honest three-way classification
  (timeout / not_found / spawn_error) with actionable messages. Turn budget 180s→300s
  default, `AMRITA_CHAT_CLI_TIMEOUT_MS` tunable (deployed at 420s).
- **E4 proof:** while a REAL turn was thinking on the deployed daemon, `/health`
  answered in 15ms and RPC ping in 13ms; the turn then completed normally
  (claude-code · sonnet). Side win: the activity feed now streams DURING turns.
- **Verification:** root 425/425 · typecheck/lint clean · live concurrent-responsiveness
  measurement above.

## Reorganization session — root-cause audit + Hermes research + master plan (docs only)

- **Date:** 2026-07-11 · **Mode:** AUDIT + planning — zero code changes; three documents added.
- **Known gap this entry does NOT fix:** the Cinema stream (ADR-0028…0031, commits
  `9a14f20`…`99ac653`) still has no ledger entries of its own — recorded as audit finding
  G-2; backfill is roadmap stage R0.
- **What landed:**
  - `docs/AMRITA_ROOT_CAUSE_AUDIT.md` — full intended-vs-actual system map with file:line
    evidence. Baseline: typecheck/lint green, **396/396 tests** at `99ac653`. Headline
    findings: the protocol constitution stops at the store (web↔daemon RPC results + WS
    frames cross unparsed, `as T`; 28 hand-typed `*Lite` shapes); role/entity enums
    re-declared up to 15× because protocol keeps them private and `daemon/rpc.ts` imports
    nothing from the protocol; `.claude/rules/` product-direction files are **not in git**
    (`.gitignore` ignores `.claude/` — contradicts CLAUDE.md and this ledger's own Phase-6
    claim); ledger stale since Phase 17; 12 commits unpushed; remote branch layout shares
    one repo with frozen v0.1 (`main` = v0.1 — push hazard); zero tags.
  - `docs/HERMES_INSPIRATION_RESEARCH.md` — mechanics of the installed Hermes 0.18.0
    (memory layers incl. two-file curated memory + compaction-as-child-session, dual hook
    systems, in-gateway cron, two-signal heartbeat, ~70 slash commands + per-channel ACL,
    session-key channel identity, profiles-as-isolated-brains, skills/curator, doctor/
    update). Includes corrections to `hermes-parity-roadmap.md` (cron understated, memory
    misframed as RAG, MCP outdated) and an adoption shortlist.
  - `docs/strategy/reorganization-master-plan.md` — STORM-planned phases 3–8: Project
    Brain + skill registry (System/Shared/Project, mandatory registry/permissions/docs),
    Preview Windows incl. Claude-CLI remote (lane-console over the lane contract),
    native Design Runtime, Global Amrita + System Brain (reserved system project,
    two-signal heartbeat, typed cron), multi-channel (operator-service extraction first,
    session-key identity, WhatsApp official-API-only), repo governance (branch rename,
    tags, changelog, rollback, phase-done checklist), and the staged roadmap R0–R6.
    **Binding rule recorded: no preview/canvas/design features before R0–R1 close.**
- **Verification:** full gates run this session (typecheck ✓ · lint ✓ · test 396/396 ✓);
  git/remote state verified against `git ls-remote`; Hermes claims read from the live
  install at `/usr/local/lib/hermes-agent` + `/root/.hermes` (read-only, no secret values).
- **Explicitly not done (needs approval):** committing/pushing anything, branch rename,
  tags, tracking `.claude/rules/`, resolving the CLAUDE.md WIP hunk — all sequenced in R0.
- **Next:** R0 slice 1 — ADR for protocol RPC-result schemas + WS frame union, then the
  enum-export sweep (master plan §7/§9).

## Phase E — Screenshot-Brief layout inversion (2026-07-12)
- **Directive:** the 5-region PDF brief — (1) delete a project / a session, (2) fold the
  right rail into Settings, (3) Settings entry bottom-left with topic pages, (4) chat at
  the side, (5) the center is a live interactive canvas showing what Amrita builds.
- **ADR-0038** (`docs/adr/0038-project-delete-session-archive.md`): session "delete" =
  `conversation.archive` (existing `conversation.archived` event; history preserved);
  `project.delete` = the single sanctioned destructive verb — `store.deleteProject` cascades
  over every owned table in ONE transaction; the reserved `system` project is refused
  (`conflict`). Migration `0008_project_delete_cascade` re-scopes the `decisions_no_delete`
  trigger behind a same-transaction guard flag keyed to the exact project id — casual
  decision deletes still abort. Wire coverage (ADR-0032) forces result schemas for both
  verbs; round-trip test exercises them.
- **Layout inversion (`apps/web`):** grid is now sidebar · **center stage** · chat (right,
  clamp 330–430px). The stage hosts Canvas (default) / Project / Brain / Settings behind
  segmented tabs; the inspector rail is deleted — its knowledge panels became the Project
  board (auto-fill card grid), the token card became Settings → **Access** (jumps there on
  401), approvals render inside the chat column whenever pending. The canvas auto-opens
  the newest artifact produced mid-session ("she builds, you watch"); gallery + premium
  empty state otherwise. Sidebar: per-session archive (✕) + compress (⤓), per-project
  delete (🗑 → type-the-slug confirm), **Settings pinned bottom-left** with a token dot.
  Mobile tabs: Chat / Canvas / Project / Brain; Settings via the drawer footer.
- **Design bugs found & fixed in browser QA:** `.sidebar .list button {width:100%}`
  stretched tree icon buttons (scoped opt-out); shell modifier `stage-<view>` collided
  with the `.stage-project` pane class (dropped the shell modifier); multicol masonry
  overflowed horizontally inside the fixed-height stage (switched to auto-fill grid);
  stage Refresh now reloads the project list too; delete-confirm buttons wrap.
- **Verification:** root gates ✓ (typecheck 0 · lint 0 · **429/429 tests**, incl. new
  `delete-archive.test.ts` cascade/refusal/idempotence + migration reversibility at v8);
  web gates ✓ (tsc 0 · 74/74 · vite build); Playwright QA on a throwaway stack
  (temp DB, :7481/:7482) — desktop 1440×900: stage tabs, canvas auto-open on seeded brief,
  project grid, Settings→Access, delete flow end-to-end (Scratch removed, fallback to
  System), session archive (auto-creates next session); mobile 390×844: 4 tabs, drawer
  Settings, settings pill nav; **0 console errors**.
- **Security hardening (commit-review findings, fixed at the root):** the canvas frame
  never carries the global bearer — `lanes.workspace.ticket` mints a lane-scoped,
  read-only, 6h ticket carried in the PATH (subresources inherit it; refused on
  RPC/events; constant-time compare); workspace responses ship a strict CSP
  (`connect-src 'none'`, no external subresources/forms), `Referrer-Policy:
  no-referrer`, nosniff; the listing escaper is attribute-safe. Plus a proxy-prefix
  bug found in live QA (`/lanes/` + matcher-appended `/` → SPA fallback) — fixed.
- **Live E4 proof (deployed, public link):** catalog shows BOTH brains ready
  (claude-code 2.1.207 · codex ChatGPT session); two REAL lanes ran IN PARALLEL
  through the approval gate — claude-code built a landing page, codex built a
  playable retro Snake game — both `exit done`, each in its auto-assigned
  workspace; the canvas rendered both via tickets (LIVE BUILD · done), the Snake
  game runs sandboxed on the canvas; a live chat turn answered "אני Claude Opus
  4.8" via `claude-code · opus`. Enter now sends (Shift+Enter breaks the line).
