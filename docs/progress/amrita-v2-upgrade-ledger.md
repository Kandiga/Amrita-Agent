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

## Phase S — Public-repo secret/PII audit + hardening (2026-07-13)
- **Trigger:** owner asked to "push to a public repo, after checking no tokens/keys/
  passwords leak." Reality-scan finding: `Kandiga/Amrita-Agent` is ALREADY public (since
  ~2026-06-10), all 114 commits (v2-main 108 + main + v0.1-final) already exposed — so the
  task became audit-existing-exposure + rotation-if-needed, not pre-publication.
- **Audit (workflow, 30 agents, 1.5M tokens):** 7 adversarial scanner dimensions ×
  full history + worktree + config/deploy + docs/PII + fixtures + entropy blind spots,
  each finding independently verified (fail-closed) + a completeness critic. Cross-checked
  with GitHub's own secret-scanning API (0 alerts) and manual greps.
- **VERDICT: zero credentials anywhere** — not at HEAD, not in any of 114 commits, not in
  commit messages. Nothing to rotate. The names-only design held (ADR-0032 secrets.ts
  regex; secrets.env 0600 outside the repo; no hardcoded token in auth.ts; .gitignore
  covers .env*/secrets.env/*.db). All `sk-`/`ghp_`/`token` strings are self-describing
  test fixtures, several *inverted* (they prove a refusal/scrub guard works).
- **Remediated (ADR-0042, forward commit — no history rewrite, which is useless on an
  already-public repo):** redacted third-party client identity (`openart-chanan` /
  "OpenArt bot") and operator attack-surface recon from HERMES_INSPIRATION_RESEARCH.md,
  keeping every architectural lesson; added `scripts/scan-secrets.mjs` (zero-dep,
  negative-control-verified) as the executable owner of the quality bar's "secret scan
  before push" rule; wired `pnpm scan:secrets` + a CI gate (first `.github/` on v2-main).
- **Reported, NOT changed (owner's decision):** `serve-web.mjs` binds `0.0.0.0:7461` behind
  an open firewall — the bearer-gated control plane is internet-reachable (loopback-binding
  would break the live demo link); commit metadata carries the VPS hostname on 58 commits
  (go-forward identity already clean; not a credential; not rewritten).
- **Verification:** `pnpm scan:secrets` clean (265 tracked files); gates green
  (typecheck 0 · lint 0 · 449/449); GitHub secret-scanning: 0 alerts.

## Phase P — The Claude Ecosystem panel (2026-07-13)
- **Trigger:** the operator circled the chat activity feed believing it was "the Claude Code
  CLI remote-control session," and asked it to show everything Claude Code has (connections,
  abilities, skills, MCP) plus a button to open "the session window."
- **Premise corrected (ADR-0043):** the circled strip is `activity.ts` — a reducer over
  Amrita's own turn/lane events, NOT a CLI session. And there is no attachable Claude
  process: chat spawns `claude -p` one-shot per turn, lanes spawn `claude --print` one-shot
  per run. A live terminal would be a second execution path outside the lane/approval
  contract — which R4 explicitly rejected ("the lane console IS the remote Claude window").
  So: an honest ecosystem panel, never a fake terminal.
- **What landed:**
  - **Claude Ecosystem drawer** (`ClaudeEcosystemPanel.tsx`) — 5 tabs, all from real RPCs:
    *Runtime* (live install/auth probe + version), *Abilities* (chat = **no tools**,
    structural; lanes = the real granted tool list, `Bash` withheld), *Skills*
    (`skills.list` — which had **zero UI consumers** until now), *MCP* (both CLIs' configured
    servers, "configured ≠ connected"), *Session* (the real running lane's live output, or an
    honest empty state).
  - **Quiet launcher** bottom-right of the chat column, above the composer: low-contrast pill,
    single status dot (not a count badge — a number implies unread work), turns clay + "· running"
    only when a lane is actually live. Opens a **bounded drawer over the chat column only**, so
    the canvas stays visible behind it; Esc/backdrop/✕ close it. Mobile → bottom sheet that
    leaves the 4-tab bar reachable.
  - **Wire (one field, no new verb):** `codingRuntimeStatusSchema.allowedTools?: string[]` —
    tool NAMES (not secret-shaped), populated on the `claude-code` entry only; kernel now holds
    `laneAllowedTools` and threads it into `getRuntimesStatus`.
  - **Codex was lying:** the runtime registry hard-coded codex as `executable: false` /
    "detection-only" even though ADR-0040 gave it a real chat provider AND lane runner. It now
    gets the same real two-probe (`--version` + `login status`) classification as claude-code —
    extracted into one shared `probeInstallAndAuth` owner. Live: codex reports **ready**.
  - **Console noise fixed at the source:** `stream-json.ts` emitted a progress line for EVERY
    `system` event, so Claude Code's SessionStart hook burst flooded the lane console with 20+
    `session hook_started` lines and buried the real work. Now only `init` survives (with the
    model), `tool_use` turns say **which tool** (`using Write`), and long assistant text gets a
    real ellipsis. Fix is in the shared parser → lane console, activity feed and the new Session
    tab all benefit.
  - **SSOT:** runtime/connector label+badge maps extracted from `SettingsRuntimeHub` into
    `providers-view.ts` (pure, tested) — two consumers, one owner, no drift in the honest-badge rule.
- **Verification:** root 455/455 · web 76/76 · typecheck/lint/build clean. Live QA against a
  real daemon: `runtime.status` returns claude-code `ready` + the 6 real tools and codex `ready`;
  a REAL Claude Code lane (Opus 4.8) ran end-to-end, wrote its file, and its clean 7-line output
  rendered in the Session tab while the canvas showed the file it wrote. Desktop + mobile verified.

---

## Phase H — the Project-Management OS: the agent↔domain bridge (ADR-0044)

- **Trigger:** Natanel asked to integrate the project-management method from a Fable 5 video
  (`FT8E_qEqIgM`) into Amrita — a durable, agentic PM operating system, not a pasted-on Trello.
- **Root cause found (and it was not the one in the brief):** the research packet said "schemas
  exist but the activation loop doesn't populate them." True — but the *cause* was worse.
  **Amrita's chat agent was not project-aware and could not become so.** The provider call passed
  **only the raw conversation transcript** (`kernel.ts` `listMessages().map(...)`), and
  `ChatRequest` was `{messages, model}` — **no system-prompt field and no tool surface**. The
  agent could neither READ nor WRITE the Project Companion. The only writers were a human
  hand-filling forms in a side panel and the GitHub importer. Hence: **7 projects, 25
  conversations, 298 events — and 0 tasks, 0 milestones, 0 risks, 0 open questions.** No
  `task.*` / `milestone.*` / `risk.*` / `question.*` event had *ever* been emitted.
- **And it was systemic.** Every agent→domain path was cut the same way: lane merge reports carry
  typed `tasks[]`/`decisions[]`/`followUps[]` and `project.ts` **discarded them**; `store.updateTask`
  was fully implemented, tested, and had **zero callers above the store**; `tasks.create` dropped
  `laneId`; `projects.root` was write-once and therefore unreachable (why all 7 live roots are
  NULL). The pattern: *the write path gets built and tested, then nothing is wired to call it.*
- **Corrections to the research packet:** there are **no `brain_*` tables** (the Brain is a pure
  derived projection in `harness.ts` — it cannot be richer than the empty tables feeding it), **no
  `receipts` table**, and **no `approvals` table** (approvals are in-memory, deny-on-restart;
  `preview_approvals` is the only durable one).

### What landed

- **Slice 0 — foundation.** `Store.rebuildProjections()` replays the whole log, in original append
  order, into the event-derived read model inside ONE transaction — the **executable proof of
  "views are projections"**, and the prerequisite for any new projection. Honest scope: only tables
  whose sole writer is the reducer. Clearing `decisions` reuses ADR-0038's per-project append-only
  gate exactly as designed (opened per project, cleared before commit, trigger never weakened).
  **Migration 0009 restores `idx_events_project_ts`** — created by 0004, silently dropped by the
  0007 table rebuild (whose own comment claimed "both indexes are preserved" — there were three).
  Every project-timeline read had been a full table scan since.
- **Slice 1 — Amrita becomes project-aware (the keystone).** New pure `context-pack.ts` assembles a
  bounded, deterministic, secret-free digest of live project state — charter, open risks, open
  questions, milestones, tasks in flight, decisions, memory, working tree, **honest connector
  status** — and the kernel prepends it as ONE system message. **No `ChatRequest` change and no
  adapter change**: every adapter already handled the `system` role (Anthropic lifts it into the
  `system` param, OpenAI passes it through, the CLIs' `flattenTranscript` puts it first). Reused
  the seam that existed. **No cache, therefore no invalidation**: rebuilt from the store every turn,
  so a task changed by *any* writer is in the next turn's context with no second chat message.
  Not persisted — the event log stays byte-identical to the pre-ADR-0044 world.
- **Slice 2 — the Inbox + the Scribe (the bridge).** One new aggregate, `inbox_items`, with two SQL
  CHECKs in the ADR-0018 house style: **nothing leaves the queue silently** (a promotion must NAME
  what it became; a dismissal needs a reason). **One Inbox, four origins** (user / agent / lane /
  system). The **Scribe** runs strictly *after* the turn is persisted — it can never delay a reply
  or fail a turn — parses the model's output with a **strict** schema (a malformed proposal is
  dropped, never guessed at), and files typed proposals. Triage promotes through the **existing
  typed command** a human would call, so the Inbox never becomes a second write path.
  **Auto-commit boundary (Natanel's decision): `question.opened` only** — the one inert, maximally
  reversible item — capped at 3/turn, deduped, provenance-mandatory, attributed, kill-switchable.
  Everything that *asserts* something waits for a human. A test asserts the Scribe emits
  `question.opened` **and no other domain event**.
- **Cost reality that shaped the design:** the live `fast` role resolves to `claude-code`/`haiku` —
  a **CLI subprocess**, not an API call. So the plausibility gate is *required*, not an
  optimization, and the Scribe runs off the reply path by construction.

### Verification

- root **507/507** (was 455) · web **87/87** (was 76) · typecheck 0 · lint clean · web build clean ·
  secret scan clean (270 files).
- The context pack is asserted **on the wire** (the real Anthropic request body), not on an internal
  call — the whole bug was that project state never left the store.
- Replay-equivalence, idempotency, and transactional rollback of `rebuildProjections` are tested,
  including that the append-only decisions trigger is still armed afterwards.
- **Not yet done:** slices 3–9 (charter/interview, `tasks.update` + board fields, Board/List/Timeline
  + project-scoped live push, project.setRoot + task→lane delegation + lane merge-back, weekly
  review, stakeholder hub, retrospective).
- **Not deployed.** No push, no service restart, no live-DB mutation.

### Phase H — slices 3 & 4 (the charter, and the write path that was unreachable)

- **Slice 3 — the charter ("constraints as fuel").** The brief held goal / audience / success
  criteria / scope — and nothing that makes a plan *accountable*. Migration `0011` adds
  `finish_line`, `constraints_json` and `decision_rights_json` **to the existing aggregate**, not a
  new table: the brief is a full-document upsert (ADR-0018), so extension is replay-safe and the
  down path is a plain `DROP COLUMN`. A constraint is `{kind, text, hard}` — and **`hard` defaults
  to false**: a constraint is only immovable if you say so. That flag is the fixed-vs-negotiable
  boundary the whole method turns on, and it reaches the model verbatim.
  - The context pack now renders the charter, and when it is thin it tells Amrita to **interview
    one question at a time** ("do not present a form, do not invent an answer") and to name the
    single constraint most likely to break the project.
  - **Trap found and pinned:** because `brief.updated` carries the WHOLE document, an edit that
    omits the charter does not leave it alone — it **clears** it. A store test now nails that
    behavior, and `BriefPanel` seeds every field so the UI cannot silently wipe it.
  - `charter.ts` (pure, web) parses/formats constraints and decision rights from plain lines
    (`budget: $15K net (hard)`, `vendor list -> the arts council`) so they are editable without a
    grid of inputs — and testable.
- **Slice 4 — `tasks.update`, the dormant write path, finally reachable.** `store.updateTask` has
  been implemented, tested, and callable by **nobody** since ADR-0018: no kernel method, no RPC, no
  client. A board drag was not expressible *at any layer*. Now wired end to end: RPC → kernel →
  store → event → projection → read, with a wire-contract exercise and 7 focused tests.
  - Migration `0012` adds `owner`, `due_date`, `priority`, `order_key`, `blocked_reason` +
    `idx_tasks_board`. **`taskStatusSchema` is deliberately NOT widened**: SQLite cannot alter a
    CHECK, so adding `blocked` would mean rebuilding the tasks table — exactly what `0007` did to
    `events`, and it silently lost an index doing it. A nullable `blocked_reason` gives the same
    "Waiting" column at zero migration risk and carries *more* information: not just that a task is
    blocked, but on what.
  - `order_key` is a **lexicographic fractional index**, so a drag is ONE `task.updated` touching
    ONE row — no sibling re-indexing, no write amplification, and concurrent drags cannot corrupt
    each other.
  - Field semantics, tested at every layer: **absent = leave alone, `null` = clear** (un-assign an
    owner, unblock a task) — which is why `clean()` stripping only `undefined` is load-bearing.
  - Also fixed in passing: `tasks.create` **silently dropped `laneId`** (the column, the event and
    the store all supported it), and the web client had **no `milestoneUpdate` wrapper**, so a
    milestone could never be set `active` from the UI — which silently disabled the
    `milestone-plan` rule in `companion.ts`.
  - Pre-0044 `task.created` / `brief.updated` events (no new fields) replay unchanged — tested.

- **Verification:** root **528/528** (was 455 at baseline) · web **100/100** (was 76) · typecheck 0 ·
  lint clean · web build clean. Not deployed; no push, no restart, no live-DB mutation.

### Phase H — slice 5 (the control room) + FIRST DEPLOY

- **Slice 5 — Board / List / Timeline, and the live push that makes them real.**
  - `board.ts` (pure) derives four columns from the task rows and stores nothing of its own.
    **"Waiting" is not a status** — a task is waiting when it has a `blockedReason`, so the enum
    stays untouched and the column carries *why*, not just *that*.
  - **The fractional index was the hard part and it bit back.** The first implementation
    infinite-looped and OOM-killed the test runner — caught *before* any UI was built on it. The
    rewrite carries two stated invariants: a generated key never ends on the zero digit (or nothing
    could ever be dropped above it again), and `keyBetween` is **total** (a drag handler that can
    throw is a drag handler that loses your card). Tested against 200 repeated inserts at the same
    position, 100 repeated prepends, degenerate ranges and hand-written junk keys.
  - `BoardPanel`: **the keyboard path is the contract, drag is the enhancement.** A drag-only board
    is unusable on a phone and with a keyboard, and this has to work on both. Dropping a card into
    Waiting *asks what it is waiting on* — blocked-ness is never invented.
  - The Project stage's **11-card masonry is gone** — exactly the "generic AI dashboard clutter" the
    project's own rules forbid. It is now: charter → Inbox → one projection (Board/List/Timeline) →
    a disclosure for runtime/brand/lanes.
  - **Project-scoped live push (a third WS frame, ADR-0044 §6b).** The board was worthless if a drag
    in one tab never reached the other: the WS was filtered on a single `conversationId` and the
    client ignored *every* domain event. `WS /events/ws` now takes an optional `projectId` and emits
    `{t:'project-event'}`. It deliberately carries **no cursor** — `seq` is per-conversation, so a
    project-wide stream has no global sequence — it is a *notification*, and the client refetches
    (idempotent, so missing or replaying one is harmless). Which types qualify is owned **once**, in
    the protocol, and imported by both sides.

### Deploy (E4) — 2026-07-14

- **Backup first:** online SQLite backup (not a file copy — a WAL copy can be torn) to
  `/root/.amrita/backups/amrita-pre-adr0044-20260714-174250.db`. Verified: integrity ok, schema v8,
  7 projects, 298 events, 27 conversations.
- **Applied:** `systemctl restart amritad.service` → migrations **0009–0012** applied cleanly →
  `schemaVersion: 12`. Then `amrita-web.service`. Both `active`; `:7461` → 200; `/rpc` → **401**
  (the auth gate is intact); real lane execution still enabled.
- **Live schema verified:** `inbox_items` present; `tasks` has owner/due_date/priority/order_key/
  blocked_reason; `project_briefs` has finish_line/constraints_json/decision_rights_json; all three
  indexes exist — **including `idx_events_project_ts`, missing since the 0007 bug.**
- **Live E4 smoke on a SCRATCH project** (never the 7 real ones): `tasks.create` with board fields →
  **`tasks.update`** (the path that had zero callers for four ADRs) → `inbox.capture` +
  `inbox.triage` → charter with a hard budget constraint and decision rights → read back correct.
  Then `project.delete` cascaded it away.
- **Live data untouched:** 7 projects, 298 events, 5 decisions, 1 brief, `integrity_check: ok` —
  byte-for-byte the pre-deploy state, now on schema v12. The delete cascade correctly included the
  new `inbox_items` table.
- **Gates at deploy:** root **530/530** · web **124/124** · typecheck 0 · lint clean · build clean ·
  secret scan clean.
- **Not done:** slices 6–9 (project.setRoot + task→lane delegation + lane merge-back, weekly review,
  stakeholder hub, retrospective). Nothing pushed to a remote.

## Phase H — ADR-0045: honesty, control, and the rest of the loop (2026-07-14)

The six-part voice brief was reviewed against what ADR-0044 actually shipped. Most of the gap was
missing *features* — but **three of them were defects**, and they are the reason this phase exists.

### The three defects (not features — defects)

- **The system silently overwrote.** There was **no version check anywhere**. Two tabs dragging the
  same card ended with the last writer winning in silence — and because the brief is a *full-document
  upsert*, a stale save did not lose a field, it **wiped the whole charter** someone else had just
  written. Fixed with `expectedVersion` optimistic concurrency (migration `0015`).
  **The token is a counter, not a timestamp**: the first cut used `updatedAt`, and a test caught that
  two writes in the same millisecond carry the same token — a stale write would have sailed straight
  through the guard built to stop it.
- **Fact and hypothesis were indistinguishable.** A guess and a commitment looked identical on the
  card. Migration `0013` adds `certainty ∈ {stated, documented, inferred}`. Certainty follows *who
  raised it*: anything an agent worked out stays `inferred` **even after you approve it** — approval
  makes a proposal actionable, it does not make it first-hand.
- **The board was a template, and it appeared out of nothing.** Migration `0014` adds **phases** and
  `projects.activated_at`. A new project is now a *conversation*, not an empty board; the columns are
  the project's own phases, and a project with none falls back honestly to the four status buckets.

### The rest of the loop

- **Charter audit** (`charter-audit.ts`) — the critique as *code*, not as a prompt: two hard dates,
  two approvers for the same area, a budget with nobody authorised to spend it, everything marked
  negotiable, a scope item that is also out of scope. A prompt can *ask* a model to notice a
  contradiction; it cannot *guarantee* it. The machine states the findings; the model does the part
  only it can do — judging which constraint is most likely to break the project.
- **Execution routes** (`execution-route.ts`) — derived, never stored (a route depends on a runtime, a
  root and a connector, all of which move; a stored route is a lie the moment any of them changes).
  A task needing email says exactly what is missing, why, **and the risk of approving it**.
- **`projects.setRoot`** at last — `root` was write-once (settable only at `createProject`, with no
  `updateProject` anywhere), which is why all 7 live projects sat at `root = NULL`. It was not
  neglect; it was **unreachable**. The browser never picks a path: the daemon validates it against the
  allowed-roots allowlist it was started with.
- **Lane merge-back** — `lane.merge_report` carried typed `tasks[]`, `decisions[]` and `followUps[]`,
  and the reducer **threw them away**. A lane could report it created three tasks and zero rows would
  appear. They now become Inbox proposals with `origin: 'lane'` — a lane is an agent, so it proposes
  and a human disposes, exactly like the Scribe.
- **Weekly review** — two scheduler defects had to be fixed first: `intervalMinutes.max(24*60)` made
  **weekly literally inexpressible**, and run-state was an **in-memory Map**, so a restart made every
  job due — which would have fired a fresh packet on every daemon bounce. The job writes **only**
  Inbox proposals and one `message.system`; **a test asserts it emits no domain-mutating event at
  all**, and it is idempotent per ISO week.
- **The stakeholder hub** — the public object is **CONSTRUCTED from a named allowlist**, not filtered
  from the private one. A filter is a blacklist in disguise: add a field to the brief and it leaks by
  default until someone remembers to exclude it. There is **no `...spread` of any private object
  anywhere in `hub.ts`**; every value is written by hand, and progress is a *count*, never task
  titles. **The model never renders it** — it cannot be prompt-injected into publishing the budget,
  because it is not in the code path at all.
  - **A real security bug, found while testing:** `requestApproval` returns the decision **string**,
    so `if (!allowed)` was false for `'deny'` — a truthy string — and **a denied publish would have
    published**. Now compared explicitly against `'allow'`.
  - `GET /p/<slug>` is the first hole ever punched in the auth gate and is deliberately the dumbest
    component in the system: **zero SQL on the request path**, regex-validated slug checked *before*
    any path is constructed, realpath confinement, a CSP that forbids every outbound channel, no
    directory listing, per-IP rate limit, and a revoked page **indistinguishable from one that never
    existed** — a 404 must not become an oracle. The slug is **stable across republishes** (the
    video's own complaint about Cloudflare Drop was that the URL changed every time).
- **The retrospective** — computed from what actually happened (dates that slipped, questions never
  answered, risks left open, tasks that ended blocked), and **promotion out of the project is one
  lesson at a time, by hand**. A promoted lesson carries `retro:<projectId>` as its source, so the
  next project is always told *whose* experience it is being offered and can disagree with it.
  **There is deliberately no "promote all" — and a test asserts no such verb exists.** Cross-project
  contamination is not a bug you fix later; it is a door you never build.

### Gates

Migrations `0013`–`0017`, all additive and reversible. Root **624/624** · web **141/141** ·
typecheck 0 · lint clean · build clean · secret scan clean.

### Post-review hardening — the hub, after an adversarial pass (2026-07-14)

An adversarial security review was run against the diff before deploy. It **confirmed the leak
design holds** — the constructor-allowlist (no `...spread`, no private field reachable), the escaping,
the `default-src 'none'` CSP, the zero-SQL request path, the approval gate (`decision !== 'allow'`),
the slug validation-before-path, and the revoked/never-existed 404 equivalence all verified sound.
It found **two real defects and one trap**, all now fixed:

- **Revoke could fail OPEN.** The public reader executes zero SQL, so it serves whatever `<slug>.html`
  is on disk — the *file* is the takedown, not `revoked_at`. But `revokeHub` deleted with
  `rmSync(force:true)` inside a swallow-everything `catch`, then marked the DB revoked and returned
  `{ok:true}`. On the Windows-first target a scanner or the operator's own browser holding the file
  open (EPERM/EBUSY) — or a read-only mount (EROFS) — would leave the page **live while the system
  reported it down**. Now the unlink runs **first** and fails **closed**: only "already gone"
  (`ENOENT`) counts as removed; any other error throws *before* the DB is touched, so a takedown is
  never reported unless the bytes are actually gone.
- **The rate limiter keyed on `remoteAddress` — always the loopback proxy.** The daemon binds
  loopback; the internet reaches `/p/` only through `serve-web.mjs`, so every visitor looked like
  `127.0.0.1`: all strangers shared one 60/min bucket (a self-inflicted 429 storm) and the "per-IP"
  cap protected nothing. The proxy now appends the true peer as the **rightmost** `x-forwarded-for`
  hop, and the daemon trusts that hop **only from a loopback peer** and only the rightmost entry (so a
  client cannot spoof it). The hit map is now **bounded** (expired windows evicted past a cap) so a
  flood of distinct sources — cheap over IPv6 — cannot grow it without bound. Four unit tests pin the
  keying and the not-shared-bucket property.
- **`esc` did not escape `'`** — safe today (every site is a text node or a double-quoted/enum/numeric
  attribute) but a trap for any future single-quoted-attribute edit. Now escaped.
- **`cache-control` was `public, max-age=60`** — a successful revoke could still be served from cache
  for up to a minute. Now `no-store`: a takedown is immediate.

### Deploy (E4) — ADR-0045, 2026-07-14

- **Backup first (online, not a file copy):** `db.backup()` to
  `/root/.amrita/backups/amrita-pre-adr0045-20260714-adr0045.db` — integrity ok, schema v12, 7
  projects, 302 events.
- **Dry-run before touching live:** migrations `0013`–`0017` applied to a **copy of the real DB**
  (v12 → **v17**, all data intact, integrity ok) **and reversed cleanly back to v12** — the strongest
  evidence short of touching production.
- **Applied:** `systemctl restart amritad.service` → migrations `0013`–`0017` applied to the live DB →
  **`schemaVersion: 17`**; `tasks` gained certainty/version/phase_id/derived_from_json; briefs gained
  version/certainty_json; `phases` and `project_publications` present; `projects.activated_at`
  present; `integrity_check: ok`; live data unchanged (7 projects, 302 events, 5 decisions). Then a
  second daemon restart to load the post-review hub hardening, and `amrita-web.service` restarted to
  load the updated proxy. Both `active`; `:7461` → 200; `/rpc` → **401** (gate intact); real lane
  execution still enabled.
- **Live E4 smoke on a SCRATCH project** (never the 7 real ones): charter with a hard budget
  constraint + decision rights → **charter audit** (readyToActivate, 1 finding) → **activate** with
  explicit phases (board born from the project) → `tasks.create` with board fields → **`tasks.update`**
  → a **stale write correctly rejected with `conflict`** (no silent overwrite) → `inbox.capture` +
  list → **hub preview key set = exactly the allowlist**, leak check clean → **approval-gated publish**
  → `GET /p/<slug>` **200 with no bearer**, served bytes **contain none of the budget / vendor /
  decision-rights strings** → **revoke** → `GET` **404** (indistinguishable from never-existed) →
  **review.run** raises proposals → **retro** computes one lesson → **promote one lesson** → then
  `project.delete`.
- **Live data verified after cleanup:** 7 projects, 304 events (the +2 are `settings.updated`
  scheduler run-state on the System project), 5 decisions, 7 memory rows, `integrity_check: ok`.
  **No orphans:** zero rows in any project-scoped table (including the three new ones) reference the
  deleted scratch project; zero events point at a missing project — the cascade is correct. The one
  org-memory row the promotion wrote (user-scoped, so it survives project deletion by design) was
  removed so no smoke artifact remains in the real Org Brain.
- **Gates at deploy:** root **628/628** · web **141/141** · typecheck 0 · lint clean · build clean ·
  secret scan clean. Nothing pushed to a remote.

## Phase I — Full-platform activation sweep (2026-07-14)

A goal to make *every* button, menu and settings toggle truly active (or honestly "needs setup"),
fix bugs, and remove dead ends. Driven by two evidence-backed audits (a PM-OS completeness pass and
a five-reader full-platform control inventory), executed as eight work packages. The one binding
boundary: **honest integrations only** — anything needing a real external connector stays an honest
`needs setup`, never a faked green.

- **WP1 — chat/composer bugs.** A failed `chat.turn` used to eat the typed message and leave a ghost
  bubble that looked sent; now the draft is restored and the optimistic bubble rolled back (mirroring
  quick-capture). Selection-aware focus is reset on project/session switch (it used to ride into
  another project) and a "Talking about N tasks ✕" chip lets you clear it from the composer.
- **WP2 — the 90s deploy hang, root-caused and fixed.** `http.ts` `close()` never terminated live
  WebSocket clients, so `server.close()` never resolved and systemd SIGKILLed the daemon after the
  full 90s on every restart. Now it `.terminate()`s each client first; a `TimeoutStopSec=20s` drop-in
  backs it up. **Verified live: a restart of the patched daemon returns in 0s** (was 90s). A
  regression test asserts `close()` settles with a client connected.
- **WP3 — milestone activation.** `milestoneUpdate` had a client wrapper but zero UI call sites, so a
  milestone could never be set `active` — which permanently disabled the `milestone-plan` companion
  rule. Added Activate/Drop controls; **verified live** that an activated milestone shows as active.
- **WP4 — project create + working folder.** There was no "+ New project" control anywhere (a fresh
  DB was stuck on `system`); added one to the sidebar. Added a Working-folder panel that binds
  `projects.setRoot` — the server validates against its allowed-roots allowlist and the browser never
  picks a path. **Verified live**: `/etc` is rejected with the honest allowlist error; an allowed
  root binds. This unblocks lane delegation (every project had sat at `root=NULL`).
- **WP5 — Settings expansion.** New client wrappers + UI for the capabilities that had backend but no
  way to reach them: a **Preferences** section of toggles over `settings.get/update`
  (context-pack / scribe / auto-open-questions — the flags the daemon reads but nothing could set); a
  **model discovery datalist** backed by `providers.models` (the model box was raw free-text while a
  live `/models` probe existed); a read-only **Channels** card over `channels.list` making
  Telegram/WhatsApp visible with their honest states; and a **Global Amrita** panel over
  `system.health` + a non-mutating `system.audit`. **All verified live.** (Wrappers also added for
  `accounts.*`, `providers.probeEndpoint`, `projects.phases.create/update`; their dedicated UIs are
  the documented next slice.)
- **WP6 — honesty + polish.** "Run for real" is now *disabled*, not just annotated, when the daemon
  hasn't opted into real execution; project memory saves now confirm; the composer send button is
  disabled with no open conversation instead of silently no-op'ing.
- **WP7 — dead code + an enforced invariant.** Removed/There-were dead exports (`firstKey`), used
  `PRIORITIES` in the board select instead of a hardcoded duplicate, and un-exported internal-only
  helpers. The security-critical `NEVER_PUBLIC` denylist in `hub.ts` was a comment read by nothing;
  it is now **enforced by a test** that walks the constructed public object and asserts none of those
  field names appear at any depth.
- **WP8 — QA + deploy.** Root **630/630** · web **141/141** · typecheck 0 · lint clean · build clean ·
  secret scan clean. Online DB backup first; no schema change this sweep (all UI wiring + fixes), so
  the live DB stays at v17, `integrity_check: ok`, 7 projects untouched. Live e2e smoke of every new
  path ran on a scratch project only, then deleted it (0 orphans). Nothing pushed to a remote.

### WP9 — the remaining wrapper-ready surfaces (2026-07-14)

Completing the "everything reachable, or honestly needs-setup" mandate. All were backend
capabilities with client wrappers but no UI; none required a schema change (protocol edits were
pure `export type` aliases over existing schemas).

- **Provider Accounts + local endpoint** (`accounts.*`, `providers.probeEndpoint`, the
  `providers.endpoint.local` setting). Provider setup was CLI-only; now an account can be registered
  and pointed at the **env-var NAME** that holds its key — the name, never the value — and a local
  OpenAI-compatible endpoint can be probed and saved. Secrets never enter the request, the store, or
  the UI. **Verified live:** connect → bind `ANTHROPIC_API_KEY` → the account shows its secretRef.
- **Post-activation Phases editor** (`projects.phases.create/update`). Activation seeds a project's
  phases; this is the only way to add or rename one afterward, and since the board's columns *are*
  the phases, it reshapes the board. **Verified live:** create → list.
- **Cinema module panel** (`cinema.providers`, `cinema.mandate.list`). Honest and bridge-gated: it
  probes the external Cinema bridge and, when absent, says "needs setup — set BRAIN_BRIDGE_TOKEN and
  start the bridge" rather than faking a connection; local mandates render regardless. **Verified
  live:** mandate list reads locally with no bridge.
- Gates: root **630/630** · web **141/141** · typecheck 0 · lint clean · build clean · secret scan
  clean. Web bundle redeployed (WP9 is web + protocol-types only; the daemon needed no restart).
  Live smoke ran on a scratch project; the scratch project and the (global, non-project-scoped)
  smoke account and setting were all removed afterward — the live DB is byte-for-byte its pre-smoke
  state (7 projects, 306 events, integrity ok). Nothing pushed to a remote.

**Left as deliberate follow-ups (need their own ADR / real external work), not gaps:** native
provider tool-calling as the agent bridge; task dependencies / critical path; a real user/contact
model (owner stays free text); real mail/calendar/chat ingestion connectors (kept honestly
"planned"); Gantt; project templates; the itemized hub-diff preview; a machine-backed
"chat = no tools" ecosystem badge (needs a protocol field). Every one is recorded in the plan §17
and the ADRs.

## Phase J — Adversarial stability hardening (2026-07-14/15)

A full "no holes / fully functional / stable" pass. A 6-subsystem adversarial audit (find→verify,
12 agents) surfaced **40 confirmed robustness holes** — crashes, resource leaks, races,
data-integrity and DoS gaps. Every one was fixed with a test where testable, in four batches, and
deployed. Gates throughout: root **632** · web **141** · typecheck/lint/build/secret-scan clean.

**ST1–4 (foundational):** daemon `startHttpServer` now rejects on a taken port (was a raw uncaught
exception) and amritad exits honestly; `serve-web.mjs` got listen-error + stream-error + handler
try/catch (a file I/O race no longer crashes the internet-facing edge); a corrupt SQLite file is
quarantined on open (`.corrupt.<ts>`) instead of crash-looping; systemd gained `Wants=network-online`
+ a real `/health` readiness gate so the web edge waits for a listening daemon.

**Batch A — process/subprocess safety.** `unhandledRejection`/`uncaughtException` guards; every CLI
subprocess (chat turns, lanes) is spawned as a **process group** and tracked, reaped on daemon close
and killed as a tree (SIGTERM→SIGKILL) on timeout/abort — they used to outlive the daemon; a **default
wall-clock cap** on lanes so a child that stalls before any turn can't run forever; **BudgetGuard
wired live** so maxTokens/maxUsd abort mid-run (were post-hoc only); provider stdout bounded;
`StringDecoder` so multibyte (Hebrew/emoji) output split across reads isn't corrupted; a scheduler
re-entrancy guard.

**Batch B — HTTP/WebSocket.** WS **heartbeat** (drops half-open sockets that leaked subscriptions +
memory); **backpressure** (a client whose buffer balloons is dropped, not buffered to OOM); a
**connection cap**; **bounded replay-on-connect**; the `/p/` rate-limiter now **hard-caps** (fails
closed under a distinct-IP flood instead of growing without bound); workspace files **streamed** not
`readFileSync`'d; oversized bodies get a 400 instead of a destroyed socket; a post-headers throw tears
the response down instead of hanging it.

**Batch C — web resilience.** A **React error boundary** (a render throw no longer white-screens the
app); the chat reply **drops its fold if you switched conversation** mid-await (no more cross-
conversation corruption); `ensureProjectAndLoad` is **race-guarded** with a monotonic token; the WS
**revives on `online`/`visibilitychange`** after giving up (a slept laptop reconnects); `refreshBase`
is **allSettled** (a failing doctor no longer blanks the projects tree); the debounced loaders catch
their own errors; the optimistic `pending[]` is pruned on success.

**Batch D — store integrity.** `setProjectRoot` writes the audit event and the row in **one
transaction** (was two — a crash between them diverged the log from the row); `settings.update`
**reserves the `cascade.*` namespace** so untrusted input can't disable the decisions append-only
guard (RPC refuse + event-schema defense-in-depth); `connectProviderAccount` is **idempotent** on
(provider,label) instead of raising a raw UNIQUE error; the `workspaceTickets` map is swept and
cleared. (The Scribe's post-provider reads were wrapped in Batch A.)

**Deploy (E4):** online backup (`amrita-pre-stability-20260715.db`), daemon restart **1s** (the WP2
fix holds; the ST3 quarantine correctly did NOT trigger on the healthy DB — no `.corrupt` file). Live
DB verified: schema 17, integrity ok, **0 orphan events** — confirming the delete-cascade over the new
PM-OS tables is correct in production (the operator had deleted 5 old projects via the UI, leaving
System + one new project). Nothing pushed to a remote.

**Deliberately deferred (documented, not holes):** the spill-durability / orphan-spill-file /
memory-consolidation-retention findings are all gated on `tool.completed`, which no production code
emits yet; the optimistic-lock is single-writer-safe by construction; migration 0007.down is
conditionally reversible. One small web follow-up remains: re-mint workspace view tickets on expiry.

## Phase K — Live canvas: agent builds land on it + Claude-Design grid (2026-07-15)

**Bug: "she couldn't display it on the canvas."** Root cause — the canvas only ever rendered
artifacts DERIVED from typed project state (`buildSurfaceArtifacts`: brief/brand/tasks/lanes). HTML
that Amrita wrote in a chat reply had **no path onto the canvas at all**, so she fell back to writing
files and `python -m http.server`, which the operator's canvas never sees.

Fixed in two halves:
- **Client (`agent-canvas.ts`, pure + tested):** any COMPLETE HTML the agent produces in chat — a
  fenced ```` ```html ```` block or a whole-message HTML document — becomes an `html-preview`
  artifact and lands on the canvas, auto-opening via the existing "she builds, you watch" effect.
  Rendered ONLY inside the zero-network Stage-B sandbox (`allow-scripts`, inline-only CSP), so an
  interactive game runs but can't reach the network or the parent origin. The streaming draft is
  never rendered (no half-written HTML flicker); a changed build gets a new id so the canvas re-opens.
- **Daemon (`AMRITA_CAPABILITIES` in the context pack):** an always-on capability preamble — injected
  on EVERY project turn, even a stateless one like System — tells Amrita she has a live canvas and to
  return self-contained HTML in a ```` ```html ```` block (inline only, <256 KB, no files, no
  `http.server`). Without this the model never knew the canvas existed.

**Claude-Design grid look.** The canvas surface (gallery, empty state, open-artifact panel) now sits
on a subtle warm dot-grid backdrop, and the artifact renders as a floating framed card — rounded,
bordered, soft-shadowed — the way a claude.ai artifact reads. `CanvasFrame` also became resilient:
an oversize build shows an honest "too large to preview inline" note instead of throwing into the
error boundary.

Gates: root **632** · web **147** (+6 canvas tests) · typecheck/lint/build/secret-scan clean.
Deployed: web bundle + daemon restarted (1s). Verified the grid CSS and the extraction logic are in
the shipped bundle and the capability is in the running daemon. The operator can now ask Amrita to
build a page or a game and watch it land on the canvas.

## Phase L — The live interactive canvas (ADR-0047, 2026-07-15)

Natanel wanted a claude.ai-Design-grade canvas: watch a build take shape live, move/resize/minimize
each build as a card, select one so the next instruction targets it, several cards for multi-page
sites or variations, and full mobile. Planned with the STORM loop; built as five phases.

- **P1 — free-canvas engine.** Pure `canvas-layout.ts` (positions/size/z-order/minimize + drag/resize
  math, 7 unit tests) drives `CanvasCard` (pointer-drag on the title bar, corner resize, minimize,
  raise-on-select) inside a `FreeCanvas`. Layout is VIEW state → localStorage per conversation, never
  the event store. Every HTML build is now a movable card.
- **P2 — live build.** The claude-code chat provider already streams `text_delta`; `extractStreamingArtifact`
  pulls the partial HTML from the still-open ```` ```html ```` block in `transcript.draft` and shows it
  as a "building…" card **with scripts stripped** (a half-written `<script>` can't break the render),
  throttled to ~300ms chunks so the layers appear smoothly. On completion the full **interactive**
  artifact takes over. 4 unit tests.
- **P3 — selection-aware targeting (ADR-0047).** `chatFocusSchema` gains an `artifact` kind + `label`
  (additive-optional; a refine keeps domain kinds requiring ids). Selecting a card sets that focus;
  `renderFocus` tells the model the message is about THAT build and to return the complete updated
  HTML. A composer chip shows “Talking about <title>”.
- **P4 — multiple builds.** `agent-canvas.ts` already extracts every block; `AMRITA_CAPABILITIES` now
  instructs one ```` ```html ```` block per page/variation, each with its own `<title>` (the card
  label), and how to modify a selected build. A 3-page site or 3 variations → 3 cards.
- **P5 — mobile + QA.** Under 720px the CSS collapses absolute positioning to a full-width vertical
  stack; drag/resize hide (not touch primitives). Gates: root **632** · web **158** (+11 canvas
  tests) · typecheck/lint/build/secret-scan clean. Deployed (daemon + web, restart ~2s); the sandbox
  (opaque origin, zero-network CSP, 256 KB cap) remains the only security boundary.

### Live canvas — improve-in-place + stream into the selected card (ADR-0047, 2026-07-15)

Two refinements after Natanel used it: (1) improving a SELECTED build spawned a new card instead of
updating it; (2) the live build streamed into a separate card, not the one being worked on. Root
cause: card identity was the message id, so every turn made a new artifact. Fixed with **title-based
identity** (`artifactIdForTitle`): same `<title>` → same card id → in-place update (keeping its
position); different titles stay separate cards (multi-page / variations). And `extractStreamingArtifact`
now takes the active artifact-focus label, so an improvement streams INTO the selected card — the
operator watches it rebuild layer by layer in place. Gates: web **161** · lint/build clean. Web deployed.

## Phase M — Orchestration layer: Amrita manages Claude Code + Codex (ADR-0048/0049/0053, 2026-07-16)

The keystone (Slices 0–6: Planner seam, headless + tmux execution sessions, Conclusion Capsule,
reconcile-on-boot, Approval Constitution) and ADR-0050/0051/0052 (project-scoped Session Workspace,
session eyes + chat relay, embedded terminal with the claude.ai look) shipped in the commits up to
`ba20ecc`. This phase finishes the arc — Slices 5b/7/8 in one atomic landing (`962214e`) because
they share migration 0018 and interleave in `kernel.ts`/`rpc.ts`/protocol.

- **Slice 5b — durable lane idempotency + correlation (ADR-0053).** Migration 0018 adds nullable
  `idempotency_key`/`group_id`/`role`/`verifies_lane_id` to `lanes` + a partial UNIQUE index (many
  NULLs, one non-null key); reversible `.down.sql`. `lanes.start` dedups by key with a COMPLETE-identity
  guard (conversation, kind, goal, group/role/verification target, **and** the caller-requested jail);
  a same-key mismatch is a conflict, never a silent wrong reuse. Concurrent duplicates collapse to one
  row (single-writer transaction; the partial index rejects the loser, which is caught).
- **Slice 7 — event-driven Watcher + Conclusion Capsule in chat.** Pure `watch-decide` core + a thin
  `store.subscribe` shell; the only side effect is an `origin:'lane'` Inbox proposal (no `watcher.*`
  event, no domain mutation), deferred to a microtask so it never re-enters the fan-out; the sweep
  timer is `unref`'d and cleared on `stop()`. The capsule stays DERIVED — a read-only RPC result,
  never persisted (a test asserts no `capsule.*` event) — folded into the chat column with a
  stale-response guard so a slow fetch never paints over a switched conversation.
- **Slice 8 — confidence-gated task transition + opt-in Codex QA lane.** `resolveTaskTransition` (pure):
  a lane exiting `done` NEVER silently marks a task done; the strongest auto action is a review
  annotation (`blockedReason`), flag-gated by `orchestration.autoTaskTransition` (default off);
  partial/budget/aborted always propose. A `verifiesLaneId` lane derives `role='qa'`, inherits the
  build lane's group and output dir as its cwd, and is refused across projects.
- **Independent review (two adversarial reviewers) → two fixes.** (1) `lanes.start`
  `groupId`/`verifiesLaneId` now use `idSchema`, matching the `lane.spawned` constitution, so a
  malformed correlation id is rejected at the edge before the workspace dir is created — not deep in
  the append transaction. (2) The idempotent-identity check now includes the caller-requested jail
  (order-insensitive, only when paths were explicitly given, so the no-scope `delegateTask` retry still
  reuses). Both locked with tests.
- **Gates & proof.** root **768** · web **175** · typecheck/lint/protocol-build/web-build clean ·
  `git diff --check` clean · secret scan clean (372 files). Isolated E2E (temp DB, `dryRun` lanes):
  idempotency survives restart, 6 concurrent same-key → 1 row, capsule never persisted, QA cross-project
  refused (12/12). Migration 0018 up→down→up 10/10. **Live deploy:** daemon restarted on the real DB
  (`/root/.amrita/amrita.db`) → **schema 18** applied on boot, `ok:true`; web serving the fresh capsule
  bundle; the four new RPC methods (`orchestration.capsule`, `lanes.session.send/finish`, `lanes.start`)
  in the running surface; clean boot log. Pushed `ba20ecc..962214e` to `origin/v2-main`.
  Not run (deliberate): real Claude/Codex tmux sessions on the shared `-L amrita` socket — that would
  disrupt the operator's live session; the tmux logic is covered by `FakeTmuxController` unit + isolated
  E2E instead.

### Operator console sessions — the full CLI on real project files (ADR-0054, 2026-07-16)

Natanel asked for full access to the Claude CLI's functions from inside the product. The ADR-0052
terminal already gave a full keyboard, but a goal was mandatory (and auto-typed into the pane) and
every session opened in an empty per-lane jail — the full CLI ran on nothing. Two additive-optional
`lanes.start` inputs close it: **`workspace:'project'`** resolves the project's bound working folder
as the session cwd (daemon-side, before the ADR-0053 idempotency lookup so the folder is part of the
operation's identity; honest conflict when no folder is bound; explicit `scope.paths` still win), and
**`sendGoal:false`** makes the goal a label — nothing is auto-typed; goal delivery is settled on the
durable event log at start so restart/resume/snapshot never type the label into the console. The
Session Workspace UI: goal now optional ("Open console"), a Folder select (project folder default /
isolated jail), honest hint. Security unchanged: folder already inside `laneAllowedRoots`, Approval
Constitution still gates every open (interactive + writes-shared-root), agent CLI runs bare (its own
permission prompts, answered in the terminal). Gates: root **773** (+5 ADR-0054) · web 175 ·
typecheck/lint/protocol/web-build · secret scan (383) · diff-check clean.

## Phase N — Harmony: evidence-based done (ADR-0055, 2026-07-16)

Natanel's harmony directive, item 0: close the task↔evidence loop. Tasks now carry TYPED
acceptance criteria (`file` / `command` / `manual`, closed union grown only by ADR); an
operator-initiated `tasks.verify` runs them — file checks read-only inside the project's bound
folder (escape = honest failure), command checks behind ONE deny-by-default approval per run
(`/bin/sh -c` in the root, scrubbed env, wall-clock kill, output DISCARDED — exit codes only,
events stay value-free; injectable `verifyExec` keeps tests hermetic). The outcome seals as
`task.updated.verification` (additive-optional; migration 0019: `acceptance_json`/`verified_at`/
`verification_json`; pre-0055 events replay byte-identically). `resolveTaskTransition` upgraded to
a `CriteriaState`: **verified-fail blocks even a 'done' exit (evidence beats prose)**; verified-pass
+ auto flag → the review annotation carries evidence; still never a silent done. Web: criteria
chips + editor + Verify button + ✓/✗ badge (pure `task-evidence.ts`). Gates: root **792** (+19:
task-verify 11, transition evidence states, protocol round-trip/replay, migration 0019 round-trip,
wire round-trip) · web **179** (+4) · typecheck/lint/build/secret-scan clean.

### Mission Control — one screen per thread of work (HARMONY-1, 2026-07-16)

The harmony gap: the task lived in one tab, its session in another, the approval in a third, the
capsule in chat. Pure `mission-control.ts` (unit-tested) joins tasks ↔ lanes (`task.laneId`) ↔
pending approvals (`approval.laneId`) ↔ ADR-0055 evidence into ONE derived row per live thread —
attention-ranked (pending approval > failed checks > running session > waiting review > verify
nudge) with a one-line "what now". `MissionControlPanel` renders at the top of the Project stage;
read-only (actions stay with their owning panels); empty board stays quiet. Web 183 (+4),
typecheck/lint/build clean. No daemon change.

## Phase O — Harmony 2-6 in one arc (ADR-0056, 2026-07-16)

- **HARMONY-2 — notifications + rhythm.** Channel-notifier seam (`registerChannelNotifier` /
  `notifyChannels`, errors swallowed); `requestApproval` pushes to every chat paired to the project
  with inline **Allow/Deny** (callback `apr:<id>:<verdict>` re-enters the same deny-by-default owner
  gate → `resolveApproval`); scheduler kind `daily-digest` (default 24h job, silent when quiet:
  approvals waiting / sessions running / failing checks / waiting-on-you); weekly review auto-run
  already existed (`project-review` default job).
- **HARMONY-3 — GitHub evidence (CONN-1 phase 1).** Criterion union += `github-pr {repo, number}`,
  verified read-only via `pulls/{n}/merge` with GITHUB_TOKEN (204/404 definitive; unknown = honest
  failed check, never a silent pass).
- **HARMONY-4 — QA/Compare one click.** SessionsPanel buttons: completed lane → "QA with <other
  agent>" (`verifiesLaneId` — inherits workspace/group/role); any goal-ful lane → "Compare with
  <other>" (same goal, `groupId` = source lane, role `compare`).
- **HARMONY-5 — Planner v2.** A chat-delegated build now PROPOSES its decomposition: a tracking
  task linked to the session + one Inbox proposal per mandate deliverable (proposed, never forced).
- **HARMONY-6 — first real Brain ingestion.** `harness.importIcs`: pure bounded RFC-5545 parser →
  Brain records with `calendar-import` provenance (an honest import source; no fake connector).
- Gates: root **803** (+11: notify 4, channels callbacks 3, ingest 3, github-pr 1) · web 183 ·
  typecheck/lint/protocol/web builds · secret scan (395) · diff-check — all clean. ADR-0056.

### Terminal reconnect hydration (ADR-0052 follow-up, 2026-07-16 night)

Found live: a browser refresh left the embedded terminal blank except the agent's spinner line —
a control-mode attach streams DELTAS only, so a reconnecting client saw nothing until the next
repaint. Fix in the bridge: on attach, `capture-pane -e` hydrates the CURRENT screen first
(clear+home, colors kept, LF→CRLF, redacted), while racing deltas buffer until the snapshot lands —
snapshot first, then deltas, always. Real-tmux test asserts the first output is the hydration frame.
Root 804, lint/secret-scan clean. Daemon-only deploy (tmux sessions survive the restart by design).

### Full session eyes — Amrita sees the whole picture, live (ADR-0051 follow-up, 2026-07-17)

Natanel: "אני רוצה שלאמריטה תהייה אפשרות לראות את כל מה שקלוד עושה… גם תוך כדי". The kernel already
captured ~500 redacted scrollback lines per session — but the brief kept 8 and the renderer kept 8.
Now: the NEWEST session exposes a deep tail (`orchestration.sessionEyesLines`, clamped 8..300,
default 120; older sessions get 24 so three sessions cannot flood a turn), each brief also carries
the workspace's NEWEST FILES (name · KB · mtime, read-only — artifact truth, not just screen), and
the pack budget grows with the exposed tail (bounded +22KB). Screen bytes still never enter the
store; the window is derived fresh per turn from tmux's own scrollback (the SSOT of "what he did").
Root 804, all gates clean.

### One build session per project — upgrades route INTO the running session (2026-07-17)

Natanel (after two parallel sessions made a mess): one Claude session per project; an upgrade
request goes INTO it, with Amrita managing that one build. The Planner now checks BEFORE agent
selection: when a non-terminal build session exists (`orchestration.singleSessionPerProject`,
default ON; QA/compare lanes never count), the chat request is TYPED INTO it through the guarded
send path (login/trust/blocked screens refuse → an honest Inbox note; never a sibling session).
Audited via `lane.progress: routed into the running session`; the orchestrator preamble tells
Amrita to say exactly that. 3 new tests (routed+audited / blocked→Inbox+no-sibling / setting-off
restores spawning). Root 807, all gates clean.

## Phase P — Community install & onboarding (audit remediation, 2026-07-17)

A clean-room audit (fresh non-root user, disposable HOME) found 17 gaps between "usable dev loop"
and "a stranger can install + open + connect their own brain safely". Fixed in evidence-first slices
(worktree feat/community-onboarding):

- **P1 security floor.** The subscription CLI children (`claude -p`/`codex exec`) and the auth probes
  now run under the deny-by-default `scrubEnv` — a stray `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the
  daemon env can no longer bill the wrong account or fake a subscription `ready` (proven with a real
  child process). `drizzle-orm 0.44.7→0.45.2` closes GHSA-gpj5-g38j-94v9; `pnpm audit --prod` clean.
- **P2 honest auth mode.** The runtime probe parses the CLI's OWN status (`claude auth status` JSON
  `authMethod`; `codex login status`) into an observed `authMode` (subscription|api-key) — never from
  exit code; the label derives from it (an API key is never mislabelled a subscription). Login hints
  corrected to the official `claude auth login` / `codex login`. The API-key wizard stops claiming
  "connected" on env-presence (validated on the first turn instead of a false green).
- **P3 doctor profiles.** Sections carry `core|optional|private`; the top-line status rolls up CORE
  only; the private Cinema/brain-bridge module is hidden unless `BRAIN_BRIDGE_TOKEN`/URL is set; an
  installed-but-unauthenticated EXECUTABLE runtime (codex parity) warns instead of masking `ok`.
- **P4 lane safety.** A blocked/aborted/non-done real lane exits the CLI with code 3 (was a
  misleading 0). The installer now binds an explicit non-Amrita workspace root + `WorkingDirectory`
  so `$HOME`/the source checkout never becomes the jail (finding 10).
- **P5 one-command open.** `amrita open` (a launcher, before any in-process kernel) starts whatever
  is down (daemon→web), waits for readiness, and opens ONE URL carrying a one-time `#token=` the SPA
  adopts then strips — the bearer is never hand-copied. Live cold-start smoke: generated token→
  secrets.env(0600), started both, GET / → 200, unauthenticated RPC → 401, cleaned up.
- **P6 installer + CI.** `install.sh`: user-local pnpm activation (no EACCES/sudo), builds the web UI,
  installs BOTH systemd units (daemon + web) with the workspace root, and ends with `amrita open`.
  New `.github/workflows/ci.yml`: frozen install + typecheck/lint/test + web build + `pnpm audit
  --prod` + secret scan, plus a clean-install job proving install→build→serve `GET / = 200` and
  unauthenticated RPC = 401 on every push.
- **P7 docs.** README: 60-second `amrita open` quickstart, honest billing-owner copy, and a truthful
  supported/experimental/not-supported platform matrix.

Gates: root **823** tests, web **186**, typecheck/lint clean, `pnpm audit --prod` clean, secret scan
clean. Deferred (honest): full hosted-API-key live validation (no test creds), macOS CI evidence,
version-pinned release channel, kernel fail-closed on missing roots (3 tests + the live daemon rely
on the cwd default; the installer now writes explicit roots instead).
