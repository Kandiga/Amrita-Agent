# v0.1 → v2 harvest map

v0.1 (frozen at tag `v0.1`, in the original `amrita-agent` repo) is a **reference implementation**,
not a copy-paste source. This table maps each battle-tested v0.1 module to the v2 package that
should re-derive it, what logic / tests / edge cases are worth carrying, and what to deliberately
leave behind. "Reuse" means *re-implement the behaviour against the new typed contracts*, porting the
tests — not lifting code.

> Rule of thumb: carry the **edge cases and their tests** (they encode hard-won lessons); rewrite the
> **plumbing** against the protocol/store.

## Required mappings

### 1. Claude Code local-login provider + `auto` provider
- **v0.1 modules:** `src/core/providers/claude-cli.ts`, `registry.ts`, `resolver.ts`
- **v2 package:** `packages/providers` (Phase 1) → a `subscription_cli` auth mode + role policy
- **Reuse (logic):** the read-only login probe `claude auth status --json` →
  `{installed, loggedIn, authMethod, subscriptionType}` (**no token**); `friendlyClaudeError()`
  credit/login detection; the deterministic recommendation rules (healthy current → claude-code if
  logged in → keep explicit login/local → configured API → first API); `resolveProviderId('auto')`.
- **Reuse (tests/edge cases):** the `claude-stub.sh` seam via an env-var bin override
  (`AMRITA_CLAUDE_BIN`); the live-health **cache keyed on the CLI path** (staleness bug fix); the
  ambient-`*_API_KEY`-clearing test setup; "auto unconfigured = warn, explicit keyless API = fail".
- **Map into the protocol:** provider role becomes the `model.request.role` enum (`fast|main|deep`);
  health/recommendation surfaces via the daemon, not ad-hoc CLI prints.
- **Do NOT carry:** the flattened-prompt text-chat bridge (v0.1 ran Claude Code as a *conversational*
  brain with its tools disabled). In v2, Claude Code is a **lane** (D7) consuming a `LaneMandate`,
  not a chat completion. Also drop the bespoke async-generator stream-json bridge — the lane runner
  owns streaming.

### 2. Grouped doctor
- **v0.1 module:** `src/cli/commands/doctor.ts` (`Check.section`, `◆` glyph, collected numbered
  issues, `checkModelProvider()` auto-awareness)
- **v2 target:** PLAN §5.4 — a daemon/CLI health surface
- **Reuse (logic):** section grouping; **warn-vs-fail scoping** (unconfigured `auto` → warning;
  explicitly-chosen keyless API provider → failure); the numbered "run this exact command" footer;
  resolving `auto` before reporting.
- **Reuse (tests/edge cases):** the green-after-claude-code assertion; the auto→WARN-not-FAIL case.
- **Do NOT carry:** direct `console.log` formatting as the contract — in v2 checks return structured
  results (Zod), and the CLI/web render them. Honesty of states is the asset, not the ANSI.

### 3. Telegram owner-only allowlist
- **v0.1 module:** `src/channels/telegram/adapter.ts` (`telegramUserAllowed()`)
- **v2 package:** `packages/channels` (Phase 3) → PLAN §6.4
- **Reuse (logic):** **deny-by-default** numeric allowlist; gate **both** messages *and*
  `callback_query`; log dropped ids; message chunking for long sends.
- **Reuse (tests/edge cases):** the callback_query gating test (a CRITICAL fix in v0.1 — an
  unauthorized user could drive buttons even when messages were gated); empty-allowlist = nobody.
- **Add in v2:** pairing codes (claim ownership by entering a code the daemon prints) on top of the
  raw numeric allowlist.
- **Do NOT carry:** raw long-polling Bot-API plumbing — v2 uses **grammY**; keep the *authorization
  predicate and its tests*, not the transport.

### 4. Path-jail + env-scrubbing (security, from commit 1bdf6d8)
- **v0.1 modules:** `src/core/tools/builtin/fs.ts` (jail), `src/connectors/claude-code.ts` +
  `daemon/server.ts` (`childEnv()` scrub, static containment)
- **v2 target:** PLAN §7 items 5–6 (tool runtime in the daemon / lane sandbox)
- **Reuse (logic — port verbatim in spirit):**
  - **Path jail:** resolve → `withinBase(full, base)` = `full === base || full.startsWith(base + sep)`
    → reject absolute paths in project context → `realpathSync` on the nearest existing ancestor to
    defeat symlink escapes.
  - **Env scrub:** allowlist only (`PATH`/`HOME`/locale/Windows vars + `CLAUDE_*`); **never forward
    `ANTHROPIC_API_KEY`** into a Claude Code lane, so it uses the subscription login, not a key.
- **Reuse (tests/edge cases — these are the crown jewels):** the jail escape suite incl. the symlink
  case; the `base+sep` boundary (so `/base-evil` doesn't pass as inside `/base`); the scrub test
  asserting unrelated secrets are absent in the child env.
- **Do NOT carry:** the v0.1 web-static MIME allowlist as-is (v2 web is a Vite build, served
  differently) — but keep the "containment + explicit allowlist" stance.

## Also worth harvesting (non-required but high value)

| v0.1 module | v2 package | Reuse | Don't carry |
|-------------|-----------|-------|-------------|
| Magic-link auth (hashed one-time tokens, 30-day sessions) | `daemon` (Phase 2) | hashed-token storage, single-use semantics, expiry; tests for replay/expired-link | the bespoke HTTP handler shape — fold into Hono |
| Cron scheduler / parser | `daemon` (Phase 2) | the cron-expression parser + its tests; "cron turns strip interactive/connector tools" rule | the global setInterval loop — drive from the daemon's event loop |
| SSE / stream-json parsers | `lanes/*` (Phase 5) | robust line-buffering and partial-JSON repair tests | SSE as the web transport — v2 web uses the ws RPC stream |
| Secret handling (`setSecret`: `ENV_NAME_RE` validation, newline-strip, atomic 0600 write) + redaction | `daemon`/`providers` | the `^[A-Z][A-Z0-9_]*$` validation, atomic tmp+rename, 0600, `sk-…abc` redaction shape; their tests | storing secrets in `config.json` (already disallowed) |
| Config versioning (`_version`, stepped migration, `config.json.bak`) | `daemon` config | the stepped-migration pattern and backup-before-write | hand-rolled JSON migration if a schema lib fits better |
| Sectioned setup wizard (`SECTIONS` table, idempotent re-run, never default to a broken provider) | `cli` (Phase 3) | the section model, idempotency, "recommend a working default" UX; the auto-default test | readline/piped-stdin specifics |

## What v2 changes structurally (so don't expect 1:1)

- v0.1 *chatted through* Claude Code; v2 *delegates to* it as a lane. The provider login becomes a
  health/credit signal and a lane auth mode, not a chat backend.
- v0.1's truth was rows in tables; v2's truth is the **event log**, with rows as read models. Ported
  write paths must emit events (often via the hybrid transaction), not just upsert rows.
- v0.1 printed diagnostics; v2 returns **typed** diagnostics and renders them. Keep the *judgements*
  (what's healthy, what's a warning vs a failure), not the formatting.
