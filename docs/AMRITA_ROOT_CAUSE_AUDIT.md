# Amrita v2 — Root Cause & SSOT Audit

> Commissioned audit (2026-07-11): full system map before any reorganization work.
> Mode: **AUDIT** (read-only diagnosis; this document is the only artifact).
> Method: enforce-root-cause-ssot v5 — every claim carries an evidence level
> (E0 inspection · E1 static/tests · E2 integration · E3 end-to-end · E4 live)
> and is marked OBSERVED (read directly) vs INFERRED.
> Companion doc: `docs/HERMES_INSPIRATION_RESEARCH.md` (mechanics research, same session).

## 0. Stability baseline (E1 — fresh, this session)

Measured at local HEAD `99ac653` on 2026-07-11:

| Gate | Result |
|---|---|
| `pnpm typecheck` | ✅ pass (tsc --noEmit, whole workspace) |
| `pnpm lint` | ✅ pass (biome, 149 files, no fixes) |
| `pnpm test` | ✅ **396/396 tests, 33 files** |

**Conclusion:** the core is *green*, not broken. Every finding below is architectural /
governance drift, not an active failure. This is the right moment to reorganize —
before the next feature stream lands on top of the drift.

## 1. What Amrita is supposed to be (intent authorities)

Authority chain (E0 — read this session):

- `docs/PLAN.md` — v1.0 architecture: Zod protocol constitution, event-sourced store,
  role-based providers (`fast/main/deep`+`auto`), Hono+ws daemon, mandate→report lanes,
  headline decisions D1–D10.
- `docs/adr/0001…0031` — 31 ADRs; protocol/store changes gated on them. The ADR line is
  current and healthy (best-maintained governance artifact in the repo).
- `docs/strategy/*` — v3 north star: chat-first Project OS; Native Interactive Surface
  (Open Design = inspiration only); Claude Code as managed runtime behind
  `CodingAgentBridge`; deterministic provider/runtime selection
  (session > lane > project > global > auto); Windows-first installer; organizational
  brain = engineered agentic knowledge harness (not RAG, not a vault).
- `.claude/rules/amrita-product-direction.md` + `amrita-quality-bar.md` — binding session
  rules (⚠️ finding G-1: not actually in git).
- `docs/progress/amrita-v2-upgrade-ledger.md` — the single progress receipt
  (⚠️ finding G-2: stale since Phase 17).

Identity invariants (v0.1 → v2, non-negotiable): conversation is the interface; projects
are the unit of memory; connectors not shells; honest integrations only; secrets never
enter the store (env-var NAMES only); every boundary crossing is Zod-parsed.

Intended package map (`PLAN.md` §2): `protocol, store, providers, daemon, channels, web,
lanes/*` — note the standalone **`providers`** package (see M-1: never built).

## 2. What actually exists (reality map)

All OBSERVED by direct read; sizes are `src/` only. Protocol version 0.3.0;
migrations `0000`–`0006` all present and in lock-step with `docs/specs/store.md`.

| Package | Size | Owns | Test coverage |
|---|---|---|---|
| `@amrita/protocol` | 11 files, ~1,820 LOC | 64-event constitution (`eventPayloads`), envelope, lane mandate/report, RPC unions, entities, secrets regex, connector manifests, harness schemas, `cinema.ts` (211), `cinema-audio.ts` (605) | 48 cases: round-trips, refines, strictness, secret-field invariant |
| `@amrita/store` | 5 files, ~2,865 LOC | `store.ts` (1,839 — appendEvent write path, ~70 typed APIs, FTS, spill), `project.ts` projection reducer, Drizzle mirrors, `migrate.ts` (BEGIN IMMEDIATE lock) | 61 cases incl. migration up/down/up |
| `@amrita/daemon` | 16 files, ~5,969 LOC — **largest, most concerns** | `kernel.ts` (1,952 — turn loop, roles, lanes, approvals, cinema mandates, harness), `provider.ts` (722 — catalog + adapters; the never-built `providers` package lives here), `rpc.ts` (675 — 77-method registry), `doctor.ts`, `cinema.ts` (proxy → brain-bridge:8799), `home.ts` (~/.amrita), `http.ts` (HTTP+WS), `runtimes.ts`, connectors/github/auth/stdio | 21 files, 169 cases |
| `@amrita/channels` | 5 files, ~524 LOC | Telegram owner-gate + pairing + operator commands; live long-poll runner; `WebChannel` (test-only orphan) | 16 cases |
| `@amrita/lanes` | 9 files, ~839 LOC | runner boundary, claude-code runner, env scrub (deny-by-default), budget guard, research seam (no provider ships) | 32 cases |
| `@amrita/cli` | 9 files, ~2,559 LOC | `commands.ts` (1,318 — registry), `setup.ts` (763 — sectioned wizard), config CLI + secret guards | 55 cases |
| `apps/web` | 29 files, ~4,655 LOC | React shell, `api.ts` (705 — hand-typed RPC wrappers, see B-1), 17 components, pure logic modules, Stage-A surface + sandbox harness | 64 cases |

Healthy signals worth protecting: event-sourcing core + projection reducer + secret-ref
discipline + role resolver are real and heavily tested; zero `TODO/FIXME/HACK` in source;
zero `as any`; secret handling layered and honest end-to-end (see §3-F).

## 3. Mixing points & SSOT violations

### 3-G. Governance (confirmed firsthand, E0)

**G-1 · CRITICAL — binding product rules are not in git.**
`.claude/rules/amrita-product-direction.md` and `amrita-quality-bar.md` exist on disk but
`git ls-files .claude/` is **empty** — `.gitignore:30` ignores `.claude/` wholesale. The
*committed* `CLAUDE.md` calls them "checked into the codebase — binding for all sessions",
and the ledger (Phase 6) claims they were "committed separately and reversibly". **Both
claims are false against observed git state.** Any clone (Windows path, another agent, CI)
silently loses the product constitution.
Violated invariant: *self-maintenance changes are audited, diffable, reversible, committed.*

**G-2 · HIGH — the single progress ledger stopped tracking reality.**
`docs/progress/amrita-v2-upgrade-ledger.md` ends at Phase 17 (ADR-0027, 2026-06-17). The
entire Cinema stream — ADR-0028/0029/0030/0031, 8 commits (`9a14f20`…`99ac653`) — has
**no ledger entry**. Receipts live only in commit messages.
Violated invariant: *one ledger, updated per phase — no scattered notes.*

**G-3 · MEDIUM — uncommitted working-tree drift in `CLAUDE.md`.**
A "Prompt Engineering Copilot discipline" rule (non-negotiable #7) sits uncommitted in the
working tree. Needs an explicit decision: commit (durable project law) or relocate
(machine-specific config). Preserved untouched by this audit.

### 3-A. Duplicated shapes / logic (deep scan, E0 with file:line)

**A-1 · CRITICAL — role enum `['fast','main','deep']` re-declared ~15×.**
Canonical-ish `PROVIDER_ROLES` at `packages/daemon/src/provider.ts:65` — nobody imports it.
Inline copies: `protocol/events.ts:101`; `daemon/rpc.ts:423,436,455,464,471` (5× in one
file); `cli/commands.ts:971,1007` + `setup.ts:421`; `apps/web/src/api.ts:187,684,693` +
`SettingsRuntimeHub.tsx:18`. The clearest SSOT violation in the repo.

**A-2 · HIGH — entity enums triplicated because the protocol keeps them module-private.**
`taskStatusSchema` (`events.ts:66`, private) vs `store/schema.ts:119` vs
`daemon/rpc.ts:137,146`; `authModeSchema` (`events.ts:69`, private) vs `store/schema.ts:226`
vs `daemon/rpc.ts:334`; milestone status re-typed at `events.ts:284,292`,
`store/schema.ts:347`, `daemon/rpc.ts:259,270` (no named const anywhere). Even *exported*
enums (`eventOriginSchema`/`eventChannelSchema`, `events.ts:18,21`) are re-declared inline
at 6 sites. Root enabler: **`daemon/rpc.ts` imports nothing from `@amrita/protocol`.**

**A-3 · HIGH — 28 hand-declared `*Lite` interfaces in `apps/web/src/api.ts:20-385`**
duplicate protocol/daemon shapes (`ConnectorStatusLite` ↔ `protocol/connector.ts`,
`ProviderCatalogEntryLite` ↔ `daemon/provider.ts:704`, harness `*Lite` block ↔
`protocol/harness.ts`, …). None imported, none runtime-validated.

**A-4 · MEDIUM — role-resolution projection copy-pasted twice inside `daemon/rpc.ts`**
(`:436-448` and `:471-484`, identical ~12-line block) + a third mirror as
`RoleResolutionLite` in web.

**A-5 · MEDIUM — channel readiness catalog triplicated:** `channels/src/index.ts:7`
(`CHANNELS`, never imported), hand-rebuilt in `daemon/rpc.ts:538-561`, and a third time in
the protocol channel enum.

**A-6/A-7/A-8 · LOW —** two same-named `chunkText` with different semantics
(`daemon/provider.ts:128` vs `channels/types.ts:46`); secret-key denylist in 3 dialects
(protocol regex / store SQL LIKE / cli guard — intentional defense-in-depth but drift-prone);
`GITHUB_TOKEN` constant defined in `github.ts:10` but raw literal in `connectors.ts:23,40`.

### 3-B. Boundary bypasses (E0)

**B-1 · CRITICAL — the web↔daemon RPC boundary crosses with zero schema parse.**
`apps/web/src/api.ts:435` `return body.result as T;`. Web imports nothing from
`@amrita/protocol` (deps: react only). Daemon side ships raw kernel returns
(`daemon/http.ts:137`) — RPC **results** have no schema on either end (only params are
validated at `rpc.ts:636`). No test binds `*Lite` shapes to daemon output → drift is
silent at runtime AND in CI.
Violated invariant: *nothing crosses a boundary unparsed.* This is the single largest
break of the project's own constitution.

**B-2 · HIGH — the protocol's WS RPC contract is dead code; the live transport diverged.**
`parseServerMessage`/`clientMessageSchema` (`protocol/src/rpc.ts`) are used only by their
own test. The real stream (`daemon/http.ts:198-214`) emits raw `JSON.stringify` frames
including `{t:'replayed'}` — a frame type **absent from `serverMessageSchema`**.
`apps/web/src/stream.ts:22-25` hand-redeclares the frame union and its comment names
`daemon/http.ts` as "authoritative" — explicitly overriding the constitution.

**B-3 · MEDIUM — external Telegram JSON enters via unchecked cast**
(`channels/telegram-runner.ts:98` `as { ok?: boolean; result?: TgUpdate[] }`);
`InboundUpdate` is a local interface, not a protocol shape.

Clean bill: the store boundary is genuinely tight — `appendEvent` parses everything;
no package outside daemon touches the store directly (grep-verified).

### 3-C. Mixed concerns (E0)

**C-1 · MEDIUM — operator business logic lives inside the Telegram adapter.**
`channels/telegram.ts:144-242` implements /status /lanes /approvals /approve /deny /stop
including approval-disambiguation rules. Each future channel would re-implement operator
UX with potentially different resolution rules. Belongs in the kernel as a typed
operator-command service; channels should only render.

**C-2 · LOW —** the adapter JSON-parses `mandateJson` for display
(`telegram.ts:172-177`) instead of receiving a typed projection.

### 3-E. Config/state duplication (E0)

**E-1 · MEDIUM — two config authorities over one file:** `daemon/home.ts:143,166` and
`cli/config-cli.ts:85-147` both read/validate/write `~/.amrita/config.json`, each with its
own guard logic.

**E-2 · LOW —** `process.env` read in ~10 files; mostly injectable, but no single config
resolver — precedence (env vs config.json vs secrets.env) is enforced ad hoc per site.

Positive: conversation/memory state is single-sourced in the store and reached only through
`kernel.runChatTurn` from all channels; `daemon/test/invariance.test.ts:24-109` proves the
cross-channel/cross-project invariants. **The user-facing "one brain" guarantee is real.**

### 3-F. Secrets (E0) — strong, no leaks found

Token-in-closure (telegram-runner), keys read at construction only, SQL CHECK tripwires,
protocol regex mirror, value-free RPC errors, web test asserts secret-free errors. Residual
risk: the 3-dialect denylist drift (A-7) only.

### 3-D. Junk/orphans (E0) — minor

Runtime artifacts at root (`agentdb.rvf`, `ruvector.db`, `.claude-remote-logs/`) are
gitignored + untracked — clutter, not a leak. `WebChannel` is a test-only orphan
(production web traffic goes HTTP `/rpc` → kernel). Zero TODO scatter.

## 4. Missing layers (planned vs built)

| # | Planned surface | Status | Evidence |
|---|---|---|---|
| M-1 | `packages/providers` (PLAN §2, ADR-0001 D1, v01-harvest) | **Never built** — lives in `daemon/provider.ts` | no such dir |
| M-2 | Windows installer / `apps/desktop` (strategy) | Docs-only (honestly stated) | `apps/` has only `web` |
| M-3 | Surface Stage B/C (generated artifacts, richer kinds) | Stage A + sandbox harness only | `surface.ts`, `sandbox.ts` |
| M-4 | Artifact library — `artifact.created` event | **Emitted nowhere**; `artifacts` table used only for spill | grep |
| M-5 | Tool execution / MCP — all 7 `tool.*` events | Referenced only by spill path; no registry, no MCP | grep; PLAN §6 non-goal |
| M-6 | `channel.*`, `conversation.renamed/archived` events | Defined, emitted nowhere | grep |
| M-7 | Memory vault export (`memory.written`, `~/Amrita` vaults, ADR-0002/0004) | Unimplemented | grep |
| M-8 | `amrita update` / `uninstall` / `service` | Absent (parity roadmap ⬜) | `commands.ts` |
| M-9 | Cron / background jobs (v01-harvest earmark, parity §10) | Zero `cron` references in src | grep |
| M-10 | Real-provider SSE streaming | Only `MockProvider.generateStream` | `provider.ts:117` |
| M-11 | Codex/OpenCode execution, research search provider, credential pool/OAuth | Honest seams only | ADR-0023/25/26 |
| M-12 | Doctor `memory`/`service`/`daemon-token` groups | Absent (cinema group added instead) | `doctor.ts` |
| M-13 | Cinema audio (ADR-0031) | Contract-only: 605 LOC + 290 test LOC, **zero in-repo consumers** (by design; execution in sibling repo) | grep |
| M-14 | Persisted `knowledge_records` + `harness.*` events | Deferred by ADR-0027 until first auto-ingest connector | ADR-0027 |

**Spec staleness (drift, E0):** `docs/specs/event-protocol.md` says ~54 events — actual
**64**; no mention of `module.mandate.*`, cinema, or harness modules.
`docs/specs/runtime.md` missing ~14 shipped RPC methods (providers.catalog/models/
probeEndpoint, harness.*, cinema.*, channels.pairing.*) and opens with a false Phase-0-era
claim. `docs/specs/channels.md` + `cli.md` still say "no real Telegram transport" — false
since ADR-0021. **`docs/specs/store.md` is the only spec in lock-step with code.**
The specs layer lags ~10 ADRs behind shipped behavior.

## 5. Dangerous-to-change zones (load-bearing walls)

Ranked by imports × blast radius × guardrail weakness:

1. **`daemon/kernel.ts` (1,952 LOC)** — God-object: only holder of store access, provider
   resolution, companion, lanes, approvals, cinema, harness. Well-tested, but its size IS
   the risk. Any reorganization must split it deliberately, not opportunistically.
2. **`protocol/events.ts`** — the constitution; but its private enums mean an enum change
   here silently requires manual edits in store + rpc + web (A-2).
3. **`store/store.ts` (1,839 LOC)** — the append/seq/spill transaction authority.
4. **`apps/web/src/api.ts` (705 LOC)** — the single un-schema'd translation layer; hand-
   typed, untested against the daemon → **highest silent-break risk in the repo**.
5. **`daemon/rpc.ts` METHODS registry** — 77 methods; web hardcodes 34 method-name strings
   independently; renames break the client with no signal.

## 6. Repository governance reality (E0 — verified this session)

| Fact | Evidence |
|---|---|
| One GitHub remote serves **two products**: `Kandiga/Amrita-Agent.git` holds v0.1 (remote `main` = `c8efe62`, frozen) *and* v2 (remote `v2-main` = `3516f16`) | `git ls-remote --heads origin` |
| Local branch is named `main` but tracks `origin/v2-main` | `git branch -vv` |
| **12 commits unpushed** — remote `v2-main` frozen at Phase 15 (2026-06-16); all config-CLI, brain-harness, and cinema work exists locally only | `ahead 12` |
| **Zero tags** in the v2 line — no release anchors, no rollback points | `git tag` empty |
| Push hazard: `git push origin main` from this worktree targets remote `main` (= frozen v0.1). Non-fast-forward rejection protects against accident; a `-f` would destroy v0.1. The naming invites exactly this mistake | branch map above |
| Runtime junk correctly gitignored — **not** a violation | `git check-ignore -v` |

## 7. Root cause statement

- **Symptom:** a green, well-tested repo whose own constitution is broken at its newest
  boundary, and whose governance artifacts (rules, ledger, remote, tags) have detached
  from reality.
- **Trigger:** three fast work streams in 3.5 weeks (onboarding/Hermes-parity, brain
  harness, cinema federation) — each kept code quality high, each treated
  boundary-contracts-beyond-the-store and governance receipts as optional follow-ups.
- **Proximate cause (technical):** the protocol package never grew RPC *result* schemas or
  the real WS frame union, and kept entity enums module-private — so every consumer
  hand-copied shapes (A-1..A-5) and the web client crossed the boundary on faith (B-1/B-2).
- **Proximate cause (governance):** no gate binds "phase done" to "ledger updated + rules
  tracked + pushed + tagged"; the quality bar exists as prose, not as an executable check.
- **Violated invariants:** *nothing crosses a boundary unparsed* (D2/CLAUDE.md #1);
  *the repo is the single source of truth for what Amrita is.*
- **Controllable root cause:** **the constitution's jurisdiction ends at the store.** The
  project enforced schema-parse where the store forced it (append path) and nowhere else;
  with no fitness function guarding "every boundary is parsed" and no governance
  enforcement loop, drift accreted exactly where enforcement was missing. Fixable and
  guardable at two writable authorities: `@amrita/protocol` (extend jurisdiction) and a
  phase-done checklist (governance loop).

## 8. Recommendations (feed the reorganization roadmap)

Core-closure work — **all of this before any canvas/preview/design-runtime feature**
(explicit product decision by Natanel, 2026-07-11):

1. **R-1 Constitution jurisdiction (fixes B-1, B-2, A-3, G1-test-gap):** add RPC result
   schemas + the real WS frame union (incl. `replayed`) to `@amrita/protocol`; daemon
   parses on the way out, web depends on the protocol package and parses on the way in;
   add a contract test binding web types to daemon output. ADR required.
2. **R-2 Export the enums (fixes A-1, A-2, A-5):** export `taskStatusSchema`,
   `authModeSchema`, milestone status, `PROVIDER_ROLES`, channel/origin enums from the
   protocol; import them in store/rpc/cli/web; delete every inline copy. `daemon/rpc.ts`
   must import from `@amrita/protocol`.
3. **R-3 Track `.claude/rules/` in git (fixes G-1):** narrow `.gitignore` from `.claude/`
   to the actually-local entries; commit the two rule files.
4. **R-4 Ledger backfill (fixes G-2):** one "Cinema stream (ADR-0028…0031)" entry; adopt
   phase-done = ledger-updated as a checklist gate.
5. **R-5 Resolve the `CLAUDE.md` WIP hunk (fixes G-3):** commit or relocate — decide, don't
   leave dirty.
6. **R-6 Governance normalization (Phase 8):** branch naming alignment, push cadence,
   first tag (`v2.0.0-alpha.N`), CHANGELOG, rollback recipe, push-hazard guard.
7. **R-7 Spec refresh or demotion:** either bring `docs/specs/{event-protocol,runtime,
   channels,cli}.md` up to date or mark them explicitly as generated views of code with a
   refresh trigger. A stale spec is worse than no spec.
8. **R-8 Kernel decomposition (deliberate, later):** split `kernel.ts` along already-clean
   seams (companion / approvals / cinema / harness) — only after R-1/R-2 land, as a
   dedicated refactor phase with invariance tests as the guard.
9. **R-9 Operator-command service (fixes C-1):** move /approve /deny /status logic from
   the Telegram adapter into a kernel-level typed service before adding WhatsApp or any
   new channel.
10. **R-10 Config authority (fixes E-1):** one owner for `~/.amrita/config.json`
    (daemon `home.ts`); CLI consumes, never re-implements.

Fitness functions to add with the fixes (make the invariants executable):
- "web imports `@amrita/protocol` and every RPC wrapper parses" (dependency + grep check);
- "no inline role/status enum outside the protocol" (lint rule or grep gate);
- "every ADR-numbered phase has a ledger entry" (docs check);
- "working tree clean + remote up to date" pre-report check in sessions.
