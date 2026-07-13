# Hermes Inspiration Research — the installed build, mechanics & what Amrita should adopt

> Research report (2026-07-11), commissioned as Phase 2 of the Amrita v2 reorganization.
> Subject: the **actually installed** Hermes agent on this server — not upstream, not docs.
> Method: read-only inspection of the live install; every claim carries a file-path and is
> OBSERVED (read directly) unless marked INFERRED. No secret values were read or quoted.
> Companion doc: `docs/AMRITA_ROOT_CAUSE_AUDIT.md` (same session).

## 0. Build identity (OBSERVED)

- Install: `/usr/local/lib/hermes-agent/` — version `0.18.0` (`pyproject.toml`),
  `git describe` `v2026.7.1-552-g05cbddc01`, HEAD 2026-07-06. **459 commits behind
  upstream** (`/root/.hermes/.update_check`); the "latest build" for this research is the
  installed 0.18.0.
- State: `/root/.hermes/` — `state.db` (2.9 GB SQLite WAL, schema v19), `SOUL.md`,
  `SECRETS_POLICY.md`, `memories/`, `cron/`, `hooks/`, `skills/`, `profiles/`.
- Live processes: **two gateway daemons** (`hermes gateway run` default profile +
  a second `--profile <redacted>`) and a Node sidecar (`brain-bridge/server.mjs` — the
  Cinema bridge Amrita's daemon proxies to).
- **Not OS-supervised**: no systemd unit, no crontab entry. The daemons keep themselves
  alive via internal guards (see §4). Worth recording: the real deployment is scrappier
  than the idealized picture — a lesson Amrita takes the other way (systemd-first deploy).

## 1. Memory — layered, not one store

| Layer | Mechanism | Evidence |
|---|---|---|
| Identity | `SOUL.md` — persona paragraph prepended to system prompt, per-profile override | `/root/.hermes/SOUL.md`, `hermes_cli/default_soul.py` |
| Curated notes | **Two markdown files**: `memories/MEMORY.md` (agent/project notes) + `USER.md` (user facts), `§`-delimited entries, hard char caps (2200/1375), old-text-match **write gate**, drift scanner, sanitized snapshot | `tools/memory_tool.py`; `config.yaml → memory` |
| Provider seam | `MemoryManager`: builtin always-first + **at most one** external provider; core tool names reserved so a provider can't shadow them; end-of-turn sync on a single serialized background worker | `agent/memory_manager.py` |
| Episodic | `state.db`: `sessions` + `messages` (live counts elided) + **FTS5 with trigram tokenizer** for substring recall; sessions carry lineage (`parent_session_id`), token/cost accounting, chat/thread identity, cwd/git context | `hermes_state.py`; PRAGMA-verified |
| Compaction | Close old session → open **child session** carrying a summary (lineage chain, never destructive rewrite); `compression_locks` + orphan-finalize guard | `agent/conversation_compression.py`, `context_compressor.py`, `trajectory_compressor.py` |
| External wiki | `/srv/projects/memory-wiki` (Natanel's add-on, **not core Hermes**): cron every 120 min compiles redacted transcripts → Obsidian vault + recall search. Reads Hermes' live SQLite directly (tight coupling) | `app/compile_to_obsidian.py`; cron job `7ef45b09ea7d` |

**Adopt:** the two-file curated memory (agent-notes vs user-facts) with char caps +
write gate + drift detection — simple, auditable long-term memory with zero RAG
machinery; FTS5-trigram substring recall; compaction-as-child-session (Amrita's ADR-0006
already mirrors the transactional pattern — the *lineage-carrying summary* is the missing
piece). **Avoid:** one unbounded multi-GB DB with pruning off; an external tool reading
another process's live SQLite (prefer an export event/API).

**Correction to existing Amrita docs:** `hermes-parity-roadmap.md` frames Hermes memory
as "doc/RAG-oriented" — inaccurate. Core Hermes memory is the two-file model + FTS
recall; the RAG-ish Obsidian pipeline is an external add-on.

## 2. Hooks — two systems, barely used, biggest doc omission

1. **In-process lifecycle hooks** (Claude-Code-style): `VALID_HOOKS` catalog in
   `hermes_cli/plugins.py` — `pre_tool_call`, `post_tool_call`, `pre/post_llm_call`,
   `pre_api_request`, **`pre_verify`** (a callback can keep the agent going:
   `{"action":"continue"}` / block), **`pre_gateway_dispatch`** (fires per inbound message
   before auth; can skip/rewrite/allow), session start/end/finalize/reset, subagent
   start/stop, approval pre/post, kanban lifecycle. Config-driven **shell hooks**
   (`agent/shell_hooks.py`) spawn a subprocess with JSON-on-stdin → JSON-decision-on-stdout,
   gated by an interactive-approval allowlist (`hooks_auto_accept: false`).
   CLI: `hermes hooks list/test/doctor/revoke`.
2. **Directory-discovered gateway hooks**: `gateway/hooks.py` scans `~/.hermes/hooks/<name>/`
   for `HOOK.yaml` + `handler.py`. Errors are caught and logged, **never block the
   pipeline** (fail-open by design for an always-on daemon).

Reality here: `/root/.hermes/hooks/` is empty; only 2 plugins enabled. A rich framework,
barely exercised. **None of Amrita's three Hermes docs mention hooks at all.**

**Adopt:** the `pre_verify` keep-going gate and `pre_gateway_dispatch` skip/rewrite seams
(typed, in-process); fail-open-and-log as the default for daemon hooks. **Avoid:** shell
hooks spawning arbitrary subprocesses — a real RCE/supply-chain surface; if ever adopted,
opt-in + sandboxed only.

## 3. Cron / scheduling — operationally central, not a nice-to-have

- Store: `/root/.hermes/cron/jobs.json` (per-profile). Four live jobs: control-panel
  watcher (**every 2 min**, 34k runs), memory-wiki compile (**every 120 min**, 531 runs),
  two weekly agent-audits (Secure Smart, Fri 18:00).
- Two job kinds: **`no_agent`** scripts (bash/python; stdout piped to Telegram; **silent
  on empty stdout** — the "speak only on problem" watchdog convention) vs **agent jobs**
  (spin up an agent with prompt + skills + toolsets + workdir).
- Engine: `cron/scheduler.py` + `cron/jobs.py`; **in-process 60s ticker thread inside the
  gateway** (`gateway/run.py:_start_cron_ticker`) — not OS cron; file locks coordinate
  with manual `hermes cron tick`; `advance_next_run` bumps next-run up-front so slow jobs
  don't re-fire; outputs archived as dated markdown under `cron/output/<job>/`.
- Provider seam: `cron/scheduler_provider.py` ABC — in-process vs external scheduler
  ("when" is pluggable, "what" is shared).
- Safety: `approvals.cron_mode: deny` — dangerous actions inside cron are auto-denied.

**Adopt:** the `no_agent` silent-on-success watchdog convention; per-job dated-markdown
output archive; the when/what split; deny-by-default approvals inside scheduled runs.
**Avoid:** cron living inside the gateway process without OS supervision — if the daemon
dies, cron silently stops. Amrita's opt-in systemd unit is the more robust base.

**Correction to existing docs:** `hermes-parity-roadmap.md` row 10 calls Hermes cron
"`cron.py` schedule/list/tick" and marks Amrita's need "⬜ evaluate". Reality: cron is
central to how this install operates (memory compaction, watching, audits). Amrita's
heartbeat/scheduler layer deserves a real design slot, not an afterthought.

## 4. Heartbeat / liveness — the two-signal idea

- **Two-signal heartbeat**: `cron/jobs.py:record_ticker_heartbeat` writes
  `cron/ticker_heartbeat` (alive) every loop and `ticker_last_success` (productive) only
  on a clean tick — `hermes cron status` can distinguish "alive but failing every tick"
  from "actually working". Both files present and fresh (OBSERVED).
- Gateway identity: `gateway.pid` + `gateway.lock` (JSON: pid/kind/argv/start_time),
  `gateway_state.json` (exit_reason, restart_requested, active_agents, platforms).
- **Restart-loop breaker** (`gateway/restart_loop_guard.py`): trips after N restarts in a
  window — prevents an auto-resumed session from re-triggering its own restart forever.
- **Self-restart footgun guard** (`cron/lifecycle_guard.py`): regex-blocks the agent from
  killing/restarting its own gateway from inside a turn or cron job.
- Restart continuity: `.restart_last_processed.json` records the last Telegram
  `update_id` so a restart doesn't reprocess/drop the in-flight message.

**Adopt:** two-signal heartbeat (most agents miss it); restart-loop breaker;
self-termination guard. **Avoid:** epoch-files-as-liveness with no external supervisor —
the guards prevent *bad* restarts but nothing causes *good* ones after a hard crash.

## 5. Special commands — ~70 slash commands + per-channel ACL

- Dispatcher: `gateway/slash_commands.py` (221 KB monolith). Adapters rewrite `!cmd` →
  `/cmd` (Telegram-friendly). Commands span session control (`/new /reset /resume /undo
  /rollback /retry /compress /context`), state (`/status /usage /credits /sessions /queue
  /pending`), model control (`/model /provider /base_url /reasoning`), work (`/goal
  /subgoal /kanban /skills /tools /run`), approvals (`/approve /deny /yolo`), voice
  (`/voice /tts /text`), platform (`/platform /channel /rooms /whoami`), lifecycle
  (`/restart /stop /update /version /whats-new`).
- **Access control**: `gateway/slash_access.py` — per-platform, per-scope (dm/group)
  allow/deny policy + an always-allowed frozenset. A channel can get a restricted subset.
- Destructive commands require confirmation (`approvals.destructive_slash_confirm: true`).

**Adopt:** per-platform/per-scope command ACL; confirm-on-destructive; `/compress
/context /undo /rollback` as user-facing memory/turn controls; the `!`→`/` rewrite.
**Avoid:** the 221 KB single-module surface — Amrita's typed registry should stay small.

## 6. Communication channels & multi-channel identity

- **~28 platform adapters** exist (`gateway/platforms/`: telegram, discord, whatsapp,
  whatsapp_cloud, slack, signal, matrix, email, sms, teams, irc, line, ntfy, relay, …)
  behind one base contract (`BasePlatformAdapter.handle_message`) with an
  `ADDING_A_PLATFORM.md` guide. **This install actively uses Telegram only**
  (`channel_directory.json`: one DM peer), via long-poll.
- Voice: populated `audio_cache/`, multi-provider TTS/STT config, voice notes transcribed
  in, replies speakable (`/voice`, `/tts`).
- Other surfaces: CLI/TUI, a large web dashboard (`web_server.py`), ACP adapter, ws relay.
- **The "one brain" answer**: one brain **per profile**, across all its channels —
  `gateway/session.py:build_session_key(platform, chat, user?)` maps every channel into
  the same `state.db` + `MEMORY.md`/`USER.md`/`SOUL.md`; `group_sessions_per_user: true`
  isolates users within group chats; the `gateway_routing` table maps channels→sessions.
- **Profiles = fully isolated brains**: `/root/.hermes/profiles/<redacted>/` has its
  own `state.db`, `SOUL.md`, `config.yaml`, `cron/`, `memories/` — a complete second
  Hermes sharing only the binary, selected by `--profile` (in production use for a
  separate third-party bot).

**Adopt:** the session-key model (channel → same brain, deterministic identity mapping) —
this is exactly the no-memory-duplication guarantee Phase 7 of the reorganization needs,
and Amrita's `kernel.runChatTurn` single-path already provides the substrate; profiles as
the multi-tenant/persona pattern (maps naturally to Amrita *projects* or future personas).
**Avoid:** 28 adapters of surface area; long-poll `update_id` in a JSON file is brittle
at the crash boundary (can drop/duplicate one message).

## 7. Skills / tools system

- **Toolsets**: `toolsets.py` — ~40 named groups (web, terminal, file, memory, browser,
  cronjob, delegation, kanban, …) with `includes` expansion; per-platform gating via
  `config.yaml → platform_toolsets` (each channel gets an allowed toolset list);
  default-off sets; webhook-safe subset.
- **Tool registry**: `tools/registry.py` — `{schema, handler, toolset, availability}`;
  **AST-scans** `tools/*.py` for `registry.register(...)` (discovery without import
  side-effects); `_generation` counter as cache-invalidation key.
- **Permissioning**: `command_allowlist` of 21 dangerous-command *patterns* (regex/
  pattern-based — defense-in-depth, not a hard boundary); `tools/approval.py` +
  `tool_guardrails.py` + `tirith_security.py`.
- **Skills**: shipped under install `skills/<category>/`; user/agent-installed under
  `~/.hermes/skills/` (31 categories live); prompt snapshot cached
  (`.skills_prompt_snapshot.json`); config gates `guard_agent_created`, `write_approval`.
- **Curator** (`agent/curator.py`): auxiliary-model background maintenance,
  **inactivity-triggered** (idle > min_idle_hours && last run > 168h) — pins/archives/
  consolidates **agent-created skills only**, never deletes (archive only), never touches
  pinned skills, runs on the auxiliary client so the main prompt cache is undisturbed.
- **MCP**: 3 servers live (`supabase`, `higgsfield`, and a third-party server) — MCP is
  working runtime here, not just a picker (corrects parity-roadmap row 9).

**Adopt:** per-channel toolset gating (the permission model Phase 3's skill registry
needs); System-vs-User skill split with `guard_agent_created` + write approval; the
curator's safety invariants (auxiliary model, inactivity-triggered, archive-never-delete,
agent-created-only); registration-without-import discovery. **Avoid:** regex/pattern
command allowlists — Amrita's structural approvals (typed approval broker, ADR-0021) are
strictly better; unattended background skill mutation without tight scoping.

## 8. Setup / doctor / self-update

- Setup: `SETUP_SECTIONS` registry, first-time-quick vs full-reconfigure vs quick-missing,
  **config backup before any prompt** (many `config.yaml.bak.*` observed), non-interactive
  fallback prints exact `hermes config set` commands. (Amrita's ADR-0026 already adopted
  this shape faithfully.)
- Doctor: ~10 grouped checks, every WARN/FAIL carries the exact fix, `--fix` does safe ops
  only, live-probe vs presence-only labeling. (Adopted in Amrita.)
- Self-update: in-place `git pull` on the live install + post-pull snapshot for
  auto-rollback if the next run fails; a manual pre-upgrade tarball is also kept.

**Adopt:** config-backup-before-reconfigure; post-update auto-rollback snapshot (for the
future `amrita update`). **Avoid:** in-place `git pull` self-update on a running daemon;
Amrita's frozen-lockfile installer + explicit backup is safer.

## 9. SOUL.md & SECRETS_POLICY.md

- `SOUL.md` = the persona/system-prompt identity layer, per-profile overridable — the
  analog of an Amrita per-project/persona identity document.
- `SECRETS_POLICY.md` = a **prose** policy the agent is told to follow: values in
  `~/.hermes/.env` (0600) / `auth.json`, never in memory files, redact in diagnostics,
  rotate after exposure. Hermes still stores secret *values* on disk in agent-readable
  config. **Amrita's env-NAMES-only store invariant is strictly stronger — keep Amrita's
  rule, don't import Hermes'.**

## 10. Architecture shape (message flow)

One long-running gateway daemon per profile: platform adapters (poll/webhook) + 60s cron
ticker + kanban dispatch in one process. Flow: Telegram long-poll → `MessageEvent` →
auth/pairing (+ `pre_gateway_dispatch` hook) → session key → history assembly
(compression-aware) → `AIAgent` turn loop (prompt = SOUL + MEMORY/USER + skills snapshot;
provider transports; tool executor with approvals/guardrails/hooks) → streamed reply with
**live Telegram message editing** → post-commit: transcript rows, memory sync, session
hooks, cost accounting. Persistence: single-transaction log+rollups, side-effects after
commit, lineage via `parent_session_id` — the exact pattern
`docs/hermes-architecture-notes.md` describes (that doc verified **accurate**, keep as-is).

**Adopt:** live message-editing streaming UX for Telegram. **Avoid:** the monolith
(995 KB `gateway/run.py`, 578 KB `main.py`, 301 KB `conversation_loop.py`) and the
all-in-one process whose crash takes every channel down. Amrita's typed modular
event-sourced kernel is the better base — this research changes *what* to build next,
not *how* to structure it.

## 11. Cross-check verdicts on Amrita's existing Hermes docs

| Doc | Verdict |
|---|---|
| `docs/hermes-architecture-notes.md` | **Accurate** — every claim verified (tx model, rollups, lineage, ToolRegistry). Keep. |
| `docs/strategy/hermes-install-architecture-study.md` | Mostly accurate; line numbers drifted (older build); memory mis-framed as doc/RAG. |
| `docs/strategy/hermes-parity-roadmap.md` | Understates cron (row 10), misframes memory (row 8), outdated on MCP (row 9 — 3 servers live). Missing entirely: hooks, heartbeat/liveness, profiles-as-brains, slash ACL, curator, session-key identity, command-approval model. |

## 12. Net adoption shortlist for the reorganization phases

1. **Two-signal heartbeat + restart-loop breaker + self-termination guard** → daemon layer.
2. **Session-key channel identity (one brain per profile)** → Phase 7 multi-channel design.
3. **Two-file curated memory with write gate + char caps + compaction-as-child-session**
   → Phase 3 Project Brain (compress/memory components).
4. **Per-channel toolset gating + guarded agent-created skills + curator invariants**
   → Phase 3 skill registry/permissions.
5. **`pre_verify` / `pre_gateway_dispatch` hook seams (typed, in-process, fail-open)**
   → daemon extension points.
6. **`no_agent` watchdog cron convention + dated output archive + cron_mode:deny**
   → Phase 6 System Brain health jobs.
7. **Slash-command ACL per channel/scope + confirm-on-destructive** → channel layer.
8. **Config-backup-before-reconfigure + post-update rollback snapshot** → future
   `amrita update`.

Anti-goals confirmed by this research: no monolith modules, no regex security, no
secret values in agent-readable files, no in-place self-update on a live daemon, no
unbounded DB growth without a pruning/compaction story.
