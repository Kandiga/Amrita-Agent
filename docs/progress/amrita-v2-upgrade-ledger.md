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

## Phase 2 — Strategy consolidation
- _(updated below when complete)_

## Phase 3 — Native Interactive Surface
- _(updated below when complete)_

## Phase 4 — Provider/model/coding-runtime control
- _(updated below when complete)_

## Phase 5 — Windows installer/update path
- _(updated below when complete)_

## Phase 6 — Self-maintenance/rules
- _(updated below when complete)_

## Phase 7 — Hardening/final verification
- _(updated below when complete)_
