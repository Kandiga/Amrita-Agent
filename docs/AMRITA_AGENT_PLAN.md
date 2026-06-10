# Amrita Agent — Architecture & Build Plan

> Planning document — the blueprint Amrita v0.1 was built from (see the repository root for the implementation). Kept as the architecture reference; deliberate v0.1 deviations: single package instead of pnpm monorepo (folders are the package boundaries), SSE instead of WebSocket, raw Telegram Bot API instead of grammY, JSON config instead of YAML, Claude Code connector via headless `claude -p` stream-json instead of the Agent SDK.
> Researched directly from: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) source (installed locally at `/usr/local/lib/hermes-agent`), the Open Design codebase (`/srv/projects/open-design-official`), the abandoned Amrita-on-Open-Design attempt (git history, commits `38d29fdf`…`37a1aa34`), `claude-control-panel`, `agent-bridge`, the obsidian-vault/memory-wiki pipeline, and web-verified provider documentation (June 2026).

---

## 1. Executive Summary

Amrita Agent is a **chat-first, project-aware, multi-channel agent operating system**. The user talks to Amrita; Amrita remembers, plans, delegates, and ships. It is architecturally a **daemon + gateway + agent runtime** (Hermes-class backend quality) with a **minimal Claude-like web UI** (sidebar of projects/sessions, one conversation pane) and **Telegram as a first-class channel**.

Claude Code, Codex, Gemini CLI, and Open Design are **optional connectors** — never the shell. When a connector works, Amrita opens a transient **lane** (console/preview panel) beside the chat; closing the lane returns to pure conversation.

The previous Amrita failed because it was a rebrand of Open Design — it inherited the tab-driven dashboard paradigm and its feature-dense UI. The new Amrita inverts that: **conversation is the product; everything else is a plugin.**

Build order: agent core + gateway first, web UI second, connectors third. TypeScript monorepo, SQLite + markdown vault storage, systemd daemon on Hostinger, public GitHub repo from day one.

---

## 2. Product Principles

1. **Conversation is the interface.** Every capability is reachable by talking. UI chrome exists only to show what conversation produced.
2. **Backend before UI.** Amrita is an agent platform with a web channel — not a web app with an agent bolted on.
3. **Projects are the unit of memory.** Opening a project = talking to an Amrita that knows that project's full history, decisions, and state.
4. **Connectors, not shells.** Claude Code / Open Design / Codex are tools Amrita drives. They appear in lanes, never as the main frame.
5. **Honest integrations.** Only official auth paths. Unconfigured = "needs setup", never faked. No ToS-violating token reuse.
6. **Calm by default, power by request.** No dashboards, no tab mazes, no settings sprawl in the main experience. Power lives in `/commands`, settings, and conversation.
7. **Local-first, public-ready.** All state on the user's server, no secrets in the repo, README-grade clarity for future contributors.
8. **Learn from Hermes, don't copy it.** Adopt its proven patterns (gateway, provider profiles, toolsets, FTS sessions, cron, doctor); avoid its known weaknesses (monolithic agent loop, regex-only security, lazy deps).

---

## 3. Architecture Overview

```
                                ┌──────────────────────────────────────────┐
                                │                AMRITA DAEMON (amritad)   │
                                │                                          │
 ┌──────────┐   WebSocket/HTTP  │  ┌────────────┐      ┌───────────────┐  │
 │  Web UI  │◄─────────────────►│  │            │      │  AGENT CORE   │  │
 │ (chat +  │                   │  │  GATEWAY   │      │  ┌─────────┐  │  │
 │  lanes)  │                   │  │            │◄────►│  │ Agent   │  │  │
 └──────────┘                   │  │  channel   │      │  │ Loop    │  │  │
 ┌──────────┐    Bot API        │  │  router +  │      │  └─────────┘  │  │
 │ Telegram │◄─────────────────►│  │  session   │      │  ┌─────────┐  │  │
 └──────────┘                   │  │  binding   │      │  │ Context │  │  │
 ┌──────────┐    local stdio    │  │            │      │  │ Builder │  │  │
 │   CLI    │◄─────────────────►│  └────────────┘      │  └─────────┘  │  │
 └──────────┘                   │        │             │  ┌─────────┐  │  │
 (later: WhatsApp, Discord…)    │        │             │  │ Tool    │  │  │
                                │        ▼             │  │ Runtime │  │  │
                                │  ┌────────────┐      │  └─────────┘  │  │
                                │  │ PROJECT &  │      └───────┬───────┘  │
                                │  │ SESSION    │              │          │
                                │  │ MANAGER    │      ┌───────▼───────┐  │
                                │  └─────┬──────┘      │ CAPABILITY    │  │
                                │        │             │ LAYER         │  │
                                │  ┌─────▼──────┐      │ • providers   │  │
                                │  │  MEMORY    │      │ • tools       │  │
                                │  │ • SQLite   │      │ • skills      │  │
                                │  │ • vault/   │      │ • plugins     │  │
                                │  │   markdown │      │ • MCP client  │  │
                                │  │ • FTS5     │      │ • connectors: │  │
                                │  └────────────┘      │   claude-code │  │
                                │  ┌────────────┐      │   codex       │  │
                                │  │ SCHEDULER  │      │   open-design │  │
                                │  │  (cron)    │      │   gemini-cli  │  │
                                │  └────────────┘      └───────────────┘  │
                                └──────────────────────────────────────────┘
                                          systemd service · Caddy reverse proxy
                                          ~/.amrita/ state · amrita CLI lifecycle
```

**One daemon, many channels, one agent core.** The web UI is just the richest channel — it can render lanes; Telegram renders buttons; CLI renders text. All channels converge on the same project/session model.

### Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript (Node ≥22)** | One language across daemon, web UI, and connectors. The two best connector SDKs are TS-first (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`). Hermes proves Python works, but Amrita's web UI + connector story is TS-native. |
| Monorepo | pnpm workspaces | `packages/core`, `packages/gateway`, `apps/daemon`, `apps/web`, `apps/cli`, `plugins/*` |
| Daemon API | Fastify + WebSocket | Lightweight, typed routes |
| Web UI | Next.js (or Vite+React) — single chat view | No tabs; SSR not critical, Vite acceptable |
| Telegram | grammY | Best-maintained TS Telegram framework, inline keyboards, sessions |
| DB | SQLite (WAL) via better-sqlite3 + FTS5 | Same proven shape as Hermes `state.db`; single-server is fine — replication is a non-goal for v1 |
| Vault | Markdown files per project (`~/.amrita/projects/<slug>/vault/`) | Obsidian-compatible, git-trackable, mirrors Natanel's existing memory-wiki habits |
| Process | systemd unit + `amrita` CLI | Hermes-style lifecycle, doctor, update |

---

## 4. Core Components & Responsibilities

| Component | Responsibility | Hermes lesson applied |
|---|---|---|
| **Gateway** | Accept messages from any channel, resolve (channel, chat, user) → (project, session), route to agent core, deliver responses + events back | Adopt Hermes `BasePlatformAdapter` pattern, but keep platform quirks OUT of the base class (Hermes leaks Telegram specifics into base — avoid) |
| **Agent Core** | The reasoning loop: build context → call provider → execute tools → stream events. **Small, composable modules** | Hermes's `run_agent.py` is a 202KB monolith — Amrita splits loop / failover / compression / prompt-builder into separate modules from day one |
| **Context Builder** | Assemble per-turn prompt: system prompt + project context pack + relevant memory + session tail. Budget-aware | Hermes `memory_manager.build_memory_context_block()` + Anthropic context-engineering guidance (minimal high-signal tokens, just-in-time retrieval) |
| **Tool Runtime** | Tool registry, toolset permission groups, execution with timeouts, structured results, audit log | Adopt Hermes toolsets (e.g. cron jobs always strip `messaging`/`clarify`); add the **append-only audit log Hermes lacks** |
| **Capability Layer** | Providers, skills, plugins, MCP client, connectors — uniform registration, global + per-project scoping | Hermes plugin discovery + declarative provider profiles |
| **Project/Session Manager** | Projects, sessions, bindings (which Telegram chat is talking to which project), lifecycle/reset policies | Hermes session reset policies (daily/idle) are good UX — adopt |
| **Memory Service** | SQLite store + markdown vault + FTS5 search + summarizer | Hermes FTS5 + compression-triggered session splits; vault replaces flat `MEMORY.md` |
| **Scheduler** | Cron jobs in natural language, delivery to any channel, locked single-executor tick | Direct adoption of Hermes cron design incl. its safety rules |
| **Lifecycle CLI** | `amrita install/status/doctor/update/repair/uninstall/gateway` | Hermes `doctor.py` / `setup` wizard patterns |

---

## 5. Data / Storage / Memory Architecture

### 5.1 Storage layout (`~/.amrita/`)

```
~/.amrita/
├── config.yaml              # master config (models, channels, toolsets, plugins)
├── secrets.env              # 0600, never in git — API keys, bot tokens
├── auth/                    # OAuth token store (per provider/connector), 0600
├── amrita.db                # SQLite WAL: sessions, messages, FTS5, bindings, audit
├── projects/
│   └── <slug>/
│       ├── project.yaml     # id, name, paths, enabled capabilities
│       └── vault/           # markdown memory (Obsidian-compatible)
│           ├── BRIEF.md         # what this project is, goals, constraints
│           ├── DECISIONS.md     # append-only decision log (ADR-lite)
│           ├── TASKS.md         # current state / next steps
│           ├── CONTEXT.md       # curated "context pack" — what every session should know
│           └── sessions/
│               └── YYYY-MM-DD-<id>.md   # auto-generated session summaries
├── skills/                  # user/global skills
├── plugins/                 # installed plugins
├── cron/                    # job definitions + outputs
├── logs/                    # daemon + gateway + per-session logs
└── cache/
```

### 5.2 What lives where — the rule

| Data | Store | Why |
|---|---|---|
| Message history, sessions, bindings | **SQLite** | Transactional, fast, FTS5 searchable |
| Full-text search index | **SQLite FTS5** | Proven in Hermes; no extra infra. Vector index deferred to a later phase (FTS5 + good summaries covers v1) |
| Project brief / decisions / tasks / session summaries | **Markdown vault** | Human-readable, diffable, Obsidian-openable, survives the DB; matches Natanel's existing obsidian-vault conventions (YAML frontmatter: `type/created/updated/tags`) |
| Curated per-project context pack | **`vault/CONTEXT.md`** | One file the Context Builder always loads — the "whole project picture" without dumping history |
| Secrets | **`secrets.env` + `auth/`** (0600) | Never in DB, never in vault, never in repo |
| Tool/plugin state | SQLite tables namespaced per plugin | Avoids the Hermes pattern of scattered JSON files |
| Audit trail | SQLite append-only `audit` table | What Hermes lacks: tool calls, permission grants, connector launches, config changes |

### 5.3 Memory flow

1. **During session**: messages append to SQLite; large tool outputs compressed (Hermes `trajectory_compressor` pattern — auxiliary cheap model summarizes oversized content).
2. **On session end/idle**: summarizer writes `vault/sessions/<date>-<id>.md` (what happened, decisions made, artifacts produced) and updates `TASKS.md` / `DECISIONS.md` when the session contained decisions.
3. **On next session start**: Context Builder loads `BRIEF.md` + `CONTEXT.md` + `TASKS.md` + last N session summaries + FTS5 retrieval for the current question. Token-budgeted, newest-first.
4. **Global memory**: `~/.amrita/USER.md` (who Natanel is, preferences) — Hermes `memories/USER.md` pattern, agent-curated with explicit "remember this" support.

---

## 6. Plugin / Skill / MCP Architecture

Three distinct capability types, one registration model:

| Type | What it is | Example |
|---|---|---|
| **Tool** | A function the model can call, grouped into **toolsets** | `file.read`, `web.search`, `shell.run` |
| **Skill** | Markdown instructions + optional scripts, loaded on demand (agentskills.io-compatible, like Hermes/Claude Code) | "deploy-checklist", "qa-pass" |
| **Plugin** | A package that can register tools, skills, channels, providers, lanes, and settings panels | `claude-code` connector, `open-design` connector, `prompt-engineer` |

**MCP** is a transport, not a fourth type: an MCP server's tools register into the tool registry like native tools, namespaced (`mcp.<server>.<tool>`). Config shape adopted from Hermes (`command/args/env` for stdio, `url/headers` for HTTP/SSE, per-server timeouts and parallelism flags).

### Scoping & permissions

- **Global registry** (`config.yaml`) + **per-project overlay** (`project.yaml`): a project can enable/disable any capability and add project-local skills/plugins/MCP servers (`projects/<slug>/skills/`).
- **Toolset gating per channel and per context**: cron always strips `messaging`/`scheduling`/interactive tools (Hermes rule); Telegram group chats get a reduced default toolset; connectors run with explicitly granted toolsets.
- **Skill safety**: adopt Hermes's skills-guard idea (static scan + trust levels: builtin / trusted / community / agent-created) but treat it as **advisory UX, not security** — real boundaries come from toolset permissions and (later) sandboxed execution. Don't repeat Hermes's mistake of treating regex scanning as a security model.
- **Settings UX**: one Settings surface with guided sections — Providers & Models, Channels, Plugins, Skills, MCP Servers, Credentials. Every item shows honest state: `configured / needs setup / disabled`. Setup happens conversationally when possible ("I need a Telegram bot token — paste it here or run `amrita setup telegram`").

---

## 7. Provider / Model / Auth Architecture

Declarative **provider profiles** (Hermes pattern), with auth mode as a first-class, honest attribute. Verified against official docs, June 2026:

### 7.1 The four auth modes

1. **`api_key`** — BYOK. Anthropic, OpenAI, Gemini, xAI, OpenRouter, any OpenAI-compatible endpoint.
2. **`cli_passthrough`** — Amrita drives a locally installed CLI agent that the *user* logged into. The CLI owns auth; Amrita never touches tokens.
3. **`oauth`** — only where a provider officially offers it to third parties.
4. **`local_endpoint`** — Ollama / llama.cpp / vLLM via OpenAI-compatible localhost URL.

### 7.2 Provider reality map (what Amrita will and won't do)

| Provider | Supported in Amrita | Mode | Notes |
|---|---|---|---|
| Anthropic API | ✅ | api_key | Direct Messages API for Amrita's own brain |
| Claude Code | ✅ | cli_passthrough via **Claude Agent SDK** | Uses the user's own login. Since **June 15, 2026**, Pro/Max plans meter SDK/headless use through a monthly Agent SDK credit ($20/$100/$200) — Amrita must surface credit-exhaustion clearly. Offering "sign in with claude.ai" to *other* users requires prior Anthropic approval — out of scope. |
| OpenAI API | ✅ | api_key | |
| Codex | ✅ | cli_passthrough via **`@openai/codex-sdk`** | The gold-standard connector: official SDK purpose-built for programs driving Codex (threads, resume, headless). ChatGPT sign-in incl. device-code is officially sanctioned for trusted local workflows. Model the whole `cli_passthrough` abstraction on this. |
| Gemini API / Vertex | ✅ | api_key | |
| Gemini CLI | ⚠️ | cli_passthrough **with API-key auth only** | Google actively detects + 429-blocks third-party software riding the free Google-OAuth tier (since 2026-03-25). Amrita must not route through user OAuth here. |
| xAI / Grok | ✅ | api_key (OpenAI-compatible) | Subscription OAuth is partner-gated (OpenCode only) — not available to Amrita; don't clone it. Grok Build CLI is beta — revisit later. |
| OpenRouter | ✅ | api_key | One OpenAI-compatible adapter covers OpenRouter + xAI + Groq + Together + DeepSeek + all local runtimes |
| Ollama / llama.cpp / vLLM | ✅ | local_endpoint | Tool-calling is best-effort on local models — Amrita validates/repairs tool-call JSON and can degrade to text-protocol tool use |

**Hard rule:** no harvesting OAuth tokens (`sk-ant-oat…`, `~/.codex/auth.json`, Gemini creds) to call raw APIs. Classified UNOFFICIAL-FRAGILE and/or ToS-violating — Amrita ships none of it.

### 7.3 Model routing

- `config.yaml`: default provider/model, **fallback chain** (Hermes pattern), per-purpose models (`main`, `summarizer` — cheap, `prompt-engineer`).
- Per-session `/model` override; per-project default model in `project.yaml`.
- Live model list fetching with cache (Hermes `models_dev_cache.json` pattern).

---

## 8. Channel / Gateway Architecture

### 8.1 Channel adapter contract

```
ChannelAdapter:
  connect() / disconnect()
  onMessage(raw) → InboundMessage {channel, chatId, userId, threadId, text, attachments}
  send(OutboundMessage)            # text, markdown, buttons?, files
  capabilities: {buttons, threads, markdown, streaming, lanes}
```

The gateway resolves every inbound message through the **binding table**: `(channel, chatId) → {projectSlug | "main", sessionId}`. Capability-aware rendering: web gets streamed markdown + lane events; Telegram gets chunked messages + inline keyboards; CLI gets plain stream.

### 8.2 Telegram flow (first-class, detailed)

**Default context = "main Amrita"** — a personal assistant not bound to any project.

```
User: /projects
Amrita: 📁 Your projects:            [inline keyboard]
        ┌──────────────────────────┐
        │ ⭐ secure-smart-crm       │
        │ 🎮 space-lions-game      │
        │ 🌐 catering-quote        │
        │ ➕ New project            │
        └──────────────────────────┘
User taps "secure-smart-crm"
Amrita: 🔄 Switched to **secure-smart-crm**.
        Last session (yesterday): fixed the quote PDF export.
        Open task: deploy to staging.
        What do you want to do?
```

- **Context indicator**: every project-bound reply is prefixed (or pinned via chat description) with `📁 secure-smart-crm`; main-Amrita replies are unprefixed. `/where` always answers "you are talking to X".
- **Switching**: `/projects` (button list), `/main` (back to main Amrita), `/new` (fresh session in current context), `/sessions` (recent sessions in current project, tappable to resume).
- **Session reset policy**: Hermes-style — daily reset hour + idle timeout, per binding, configurable.
- **Long work**: Amrita acknowledges, runs in background, sends progress + final result to the same chat (Hermes gateway pattern). `/stop` interrupts.
- **Lane fallback**: channels without lanes get links — e.g. Open Design preview URL or a short status digest of what Claude Code is doing.
- Implementation notes from Hermes worth adopting: message deduplication on edits, attachment caching, UTF-16-safe chunking — but kept inside the Telegram adapter, never in the base class.

### 8.3 Channel roadmap

1. **v1**: Web UI, Telegram, CLI (`amrita chat`).
2. **v2**: WhatsApp (Business API or bridge), Discord.
3. The adapter contract is designed so each new channel is one package in `plugins/channels/`.

---

## 9. Web UI / UX Structure

**Claude.ai-like minimalism. One screen.**

```
┌────────────┬─────────────────────────────────────┬──────────────────┐
│  SIDEBAR   │            CONVERSATION             │   LANE (only     │
│            │                                     │   when active)   │
│ ⌂ Main     │  [messages, streamed markdown,      │                  │
│            │   tool activity as collapsed         │  ┌────────────┐ │
│ PROJECTS   │   inline chips]                     │  │ Open Design│ │
│ ▸ crm      │                                     │  │  preview   │ │
│ ▸ game     │                                     │  │  iframe    │ │
│ ▸ catering │                                     │  └────────────┘ │
│            │                                     │   — or —        │
│ SESSIONS   │                                     │  ┌────────────┐ │
│ · today    │                                     │  │ Claude Code│ │
│ · jun 8    │ ┌─────────────────────────────────┐ │  │  console   │ │
│            │ │  Message Amrita…            ⏎  │ │  │  (stream)  │ │
│ ⚙ Settings │ └─────────────────────────────────┘ │  └────────────┘ │
└────────────┴─────────────────────────────────────┴──────────────────┘
```

- **Left sidebar**: Main Amrita, project list, sessions of the selected context, Settings at the bottom. That's all.
- **Main area**: the conversation. Tool activity renders as small collapsible chips ("⚙ ran shell command", "📝 updated TASKS.md"), not panels.
- **Lane**: appears only when a connector starts visible work; user can close it any time (work continues headless); reopenable from a small indicator chip. One lane at a time in v1.
- **No** top tabs, no dashboard widgets, no artifact canvases, no marketplace surface in the main flow.
- **Settings**: a single modal/page with the guided sections from §6. Honest state badges.
- **Auth**: magic-link login (proven pattern from claude-control-panel) — daemon prints/sends a one-time URL; no password forms, no token pasting in the browser.
- **Mobile**: same web app, responsive — sidebar collapses to a drawer; lanes go full-screen.

---

## 10. Project / Session Model

```
Project {
  slug, name, createdAt
  workingDir?          # optional path on the server this project's code lives at
  vaultPath            # ~/.amrita/projects/<slug>/vault
  defaultModel?, enabledCapabilities[], projectSkills[], projectMcp[]
}

Session {
  id, projectSlug | null ("main"), channelOrigin
  createdAt, lastActiveAt, status
  parentSessionId?     # Hermes-style chain when compression splits a session
}

Binding {                      # the gateway routing table
  channel, chatId → projectSlug|main, activeSessionId, resetPolicy
}
```

- A session belongs to exactly one context (main or a project). The same project can have parallel sessions from web and Telegram; they share the project vault and DB history, so "project Amrita" is consistent across channels.
- **Project sync**: if `workingDir` is set, Amrita can read the repo state (git log, files) on session start to refresh `CONTEXT.md` — the project picture stays true to reality, not just to chat history.
- Creating a project scaffolds the vault from templates (BRIEF/DECISIONS/TASKS/CONTEXT) — mirroring Natanel's obsidian-vault template habit (`project-operating-system.md`, `do-not-break.md`).

---

## 11. Open Design Connector

Open Design becomes `plugins/connectors/open-design` — optional, off by default.

**What exists today (verified in `/srv/projects/open-design-official`):** an Express daemon on `127.0.0.1:7456` with HTTP APIs (`/api/health`, `/api/projects/*`, `/api/runs/*`, `/api/chat`, `/api/artifacts/*`, `/api/skills`), an `od` CLI with `--json` output, SSE streaming for runs/chat, and artifacts on disk under `.od/projects/<id>/artifacts/`.

**Connector design:**
- Tools exposed to Amrita: `openDesign.createRun(projectId, skill, brief)`, `openDesign.status(runId)`, `openDesign.listArtifacts(projectId)`, `openDesign.health()`.
- **Lane**: when a run starts, the connector emits a lane event; the web UI opens a preview lane (iframe to the artifact preview or a rendered artifact view). Telegram gets a link + completion message with a thumbnail.
- Mapping: an Amrita project may link to one Open Design project id (stored in `project.yaml`).
- **Gaps to contribute upstream later** (not blockers): a headless mode flag, stable artifact preview URLs, a maturity webhook. v1 polls `/api/runs` status — good enough.
- Hard rule: Amrita never embeds Open Design's UI as its own chrome. The lane shows *output*, conversation stays primary.

---

## 12. Claude Code Connector

`plugins/connectors/claude-code` — the most important connector.

- **Mechanism**: the official **Claude Agent SDK** (TypeScript) in the project's `workingDir`. Streaming events (tool use, file edits, text) feed both the console lane and Amrita's own awareness.
- **Auth**: whatever the user's local Claude Code login is (subscription via Agent SDK credit, or `ANTHROPIC_API_KEY`). Amrita reads nothing — the SDK resolves credentials itself. Surface the **June 2026 Agent SDK credit** status/exhaustion as an honest message ("Claude's agent credit for this month is exhausted — switch to API key or wait").
- **Session model**: one Claude Code session per task, resumable via SDK session ids; Amrita stores the mapping in plugin state. Long-running tasks survive lane closure.
- **Console lane**: streamed, read-only by default, with an input box for direct interjection (pattern proven by claude-control-panel's tmux capture + command injection — but via SDK streams, not tmux scraping).
- **Permissions**: the connector declares which toolsets it grants Claude Code (via SDK permission modes/hooks); a per-project "autonomy level" setting (ask-every-write / confirm-dangerous / autonomous).
- **The prompt that drives it comes from the prompt-engineering plugin** (§13) — project-aware, task-scoped briefs, not forwarded one-liners.
- Same connector shape later reused for **Codex** (`@openai/codex-sdk` — officially built for this) and **Gemini CLI** (headless, API-key auth only).

---

## 13. Prompt-Engineering Plugin

`plugins/prompt-engineer` — optional, on by default for connectors. Makes Amrita a *supervisor*, not a message-forwarder.

- **Function**: given (user intent + project context pack + target tool), generate a high-quality downstream brief before any connector launch. Runs on a configurable model (can be the cheap auxiliary model).
- **Encodes Anthropic's canonical guidance** (sources to embed as the plugin's own skill files):
  - Prompt-engineering docs ladder: clear & direct → multishot examples → chain-of-thought → XML tags → role prompting → prefill → prompt chaining → long-context tips
  - *Building Effective Agents* (workflows vs agents; orchestrator-workers, evaluator-optimizer)
  - *Claude Code best practices* (CLAUDE.md design, explore→plan→code→commit)
  - *Writing effective tools for agents* + *Effective context engineering for AI agents*
  - Claude Cookbooks `patterns/agents`
- **Output shape** for a downstream agent brief: role + context (from vault) + explicit task + constraints/do-not-break list + success criteria + output contract. XML-tagged sections.
- **Per-tool templates**: a Claude Code brief differs from an Open Design brief (design language, references, artifacts) and a Codex brief.
- **Transparency**: the generated brief is visible in chat as a collapsible chip ("📋 Brief sent to Claude Code") — Natanel can inspect and edit before launch when autonomy level requires it.

---

## 14. Installer / Update / Uninstall

Hermes-quality lifecycle, via one `amrita` CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/<owner>/amrita-agent/main/scripts/install.sh | bash
```

- **install.sh**: checks Node ≥22 (installs via fnm if missing), installs the released build (GitHub Releases tarball — **not** a git clone), creates `~/.amrita/`, symlinks `amrita`, then runs the setup wizard: provider → model → channels (Telegram token) → optional connectors → systemd service (user or system scope, auto-detected).
- **Commands**: `amrita install-service | start | stop | status | doctor | update | repair | uninstall | setup | chat | logs`.
- **`doctor`** (Hermes pattern): Node/version, config validity, DB integrity, provider auth probes (`/models` ping), channel connectivity (Telegram `getMe`), connector detection (claude/codex/gemini/od on PATH), disk/permissions. Each check: pass/fail + suggested fix.
- **`update`**: queries GitHub Releases (semver), downloads, atomically swaps, restarts service, runs DB migrations. Avoids Hermes's git-pull dependency; release artifacts can be checksummed. Update check cached (6h) and shown as a gentle banner.
- **`uninstall`**: removes service + binaries; **asks** before touching `~/.amrita/` (default: preserve data, print export path).
- **Remote triggering**: `status` / `doctor` / `update` are also tools in the `admin` toolset → invokable from web chat and Telegram ("Amrita, update yourself") with confirmation. Cron can run nightly `doctor` and report to the Telegram home channel.

---

## 15. Hostinger Deployment Plan

Target: the existing Hostinger VPS (same box this plan was researched on).

```
[Internet] → Caddy (443, auto-TLS, domain e.g. amrita.<domain>)
               ├── /        → amritad web UI + API (127.0.0.1:7460)
               └── /ws      → WebSocket
Telegram → outbound long-polling from amritad (no inbound port needed)
amritad  → systemd unit, Restart=on-failure, journald + ~/.amrita/logs
```

- **Bind app to localhost only**; Caddy is the sole public surface (same discipline as Open Design's `127.0.0.1:7456`).
- **Auth at the edge**: magic-link sessions; optionally Caddy basic-auth as a second layer during alpha.
- **Telegram via long-polling** (no webhook) — zero inbound exposure, works behind anything.
- **Supervision**: systemd handles restarts; `amrita doctor` exposed as a `/healthz` endpoint for uptime monitoring.
- **Backups**: nightly cron — SQLite `.backup` + tar of `projects/*/vault` → `~/.amrita/backups/` (and optionally git-push vaults to a private repo).
- **Secrets**: only in `~/.amrita/secrets.env` (0600); systemd unit loads via `EnvironmentFile`.
- Coexists with existing services (Hermes gateway, Open Design Docker) — distinct ports, distinct state dirs.

---

## 16. Public GitHub Repo Structure

```
amrita-agent/
├── README.md                  # what/why, 60-second install, screenshot, channels GIF
├── LICENSE                    # MIT
├── docs/
│   ├── architecture.md        # distilled from this plan
│   ├── install.md             # install/update/uninstall, Hostinger guide
│   ├── channels.md            # Telegram setup walkthrough
│   ├── providers.md           # honest auth-mode table (from §7)
│   ├── plugins.md             # writing skills/plugins/connectors
│   └── CONTRIBUTING.md
├── packages/
│   ├── core/                  # agent loop, context builder, tool runtime, memory
│   ├── gateway/               # channel router, bindings, adapter contract
│   └── shared/                # types, config schema
├── apps/
│   ├── daemon/                # amritad: Fastify + WS + scheduler
│   ├── web/                   # chat UI
│   └── cli/                   # amrita lifecycle CLI + terminal chat
├── plugins/
│   ├── channels/telegram/
│   ├── connectors/{claude-code,codex,open-design,gemini-cli}/
│   └── prompt-engineer/
├── scripts/install.sh
└── .github/workflows/         # CI: lint, test, release artifacts
```

- **Public from the first commit**; secrets only ever in `~/.amrita/` (enforce with a secret-scanning CI check).
- README crediting: *built by Natanel (Nethanel Kol)*, with an "inspired by" section honestly crediting Hermes Agent (NousResearch), Claude Code, and the MCP ecosystem.
- Conventional commits + changelog + semver GitHub Releases (these drive `amrita update`).

---

## 17. Security / Secrets / Privacy

- **Secrets**: `secrets.env` + `auth/` at 0600, loaded server-side only; never sent to the browser; settings UI shows "configured ✓ (sk-…abc)" shapes only. CI secret-scan on every push.
- **Tool permission model**: toolsets per channel/context/connector (§6); destructive tools (`shell.run`, file writes outside project dirs) require per-project autonomy level; cron contexts always stripped of interactive/messaging/scheduling tools.
- **Audit log**: append-only SQLite table — every tool call, connector launch, permission grant, config change, update. (Direct fix for a named Hermes gap.)
- **Prompt-injection posture**: skills guard scanning is advisory; the real defenses are toolset boundaries, confirmation gates on dangerous actions, and connector autonomy levels. Cron prompts scanned before execution (Hermes pattern).
- **Web exposure**: localhost-bound app, TLS + magic-link at the edge, WS auth via session token, rate limiting on the auth endpoint.
- **Privacy**: all data on the user's server; no telemetry in v1 (if ever added: opt-in, documented).
- **ToS compliance**: §7's hard rules are also security posture — no token harvesting, no OAuth impersonation.

## 18. Risks & Tradeoffs

| Risk | Mitigation |
|---|---|
| **Scope explosion** (the Open Design failure mode, again) | Phased roadmap (§19) with a brutally small v1; every feature must be reachable from conversation or it doesn't ship |
| Anthropic Agent SDK credit caps make subscription-driven Claude Code work hit walls | Surface credit status honestly; one-tap fallback to API key; document in providers.md |
| Provider/CLI churn (Codex SDK beta surface, Grok Build beta, Gemini policy shifts) | Connectors are isolated plugins; a broken connector never takes down core chat |
| Single-server SQLite (no replication) | Accepted for v1 (single-user). Nightly backups. Multi-tenant is explicitly a non-goal |
| TS rewrite of patterns Hermes proved in Python | We copy *patterns*, not code; each adopted pattern cited above already has a reference implementation to study |
| Lane complexity in the web UI | One lane at a time in v1; lanes are render-only views over connector event streams — no lane-specific business logic |
| Telegram context confusion (user forgets which project they're in) | Persistent context prefix + `/where` + switch confirmations |
| Memory bloat / stale context packs | Token-budgeted Context Builder; `CONTEXT.md` is curated and size-capped; summaries not transcripts |

## 19. Phased Build Roadmap

**Phase 0 — Skeleton (week 1)**
Monorepo, config schema, SQLite layer + migrations, `amrita` CLI shell (`doctor`/`status` stubs), CI.

**Phase 1 — Agent core + CLI channel (weeks 1–3)**
Agent loop (provider profiles: Anthropic + OpenAI-compatible adapter), tool runtime + toolsets, basic tools (files, shell, web fetch), session persistence + FTS5, `amrita chat` terminal channel. *Exit criterion: a useful terminal agent.*

**Phase 2 — Projects + memory (weeks 3–5)**
Project/session/binding model, vault scaffolding + templates, Context Builder, session summarizer, project sync from `workingDir`. *Exit: project-aware conversations that resume with full picture.*

**Phase 3 — Gateway + Telegram (weeks 5–7)**
Gateway + adapter contract, Telegram adapter (grammY): `/projects` buttons, context switching, indicators, reset policies, long-task background delivery. *Exit: full project workflow from a phone.*

**Phase 4 — Web UI (weeks 7–10)**
Daemon HTTP/WS API, chat UI + sidebar + magic-link auth, settings surface, deployed behind Caddy on Hostinger. *Exit: claude-like web chat in production.*

**Phase 5 — Connectors + lanes (weeks 10–13)**
Lane event protocol, Claude Code connector (Agent SDK) + console lane, prompt-engineer plugin, Open Design connector + preview lane. *Exit: "Amrita, build the landing page" → brief → Claude Code lane → result in chat.*

**Phase 6 — Lifecycle + public release (weeks 13–15)**
install.sh + setup wizard + systemd, update via GitHub Releases, doctor (full checks), repair/uninstall, cron scheduler, docs polish, public alpha release.

**Later**: Codex + Gemini connectors, WhatsApp/Discord, vector retrieval, skill marketplace, multi-user.

## 20. Questions for Natanel Before Coding

1. **Stack confirmation**: TypeScript/Node monorepo as recommended (§3) — or do you prefer Python like Hermes? (TS recommended: one language everywhere + both connector SDKs are TS-first.)
2. **Amrita's own brain**: which provider/key should power Amrita's core loop by default — Anthropic API key, or OpenRouter? (Connectors auth separately.)
3. **Domain**: which domain/subdomain should the web UI live on (for Caddy + TLS)?
4. **GitHub**: repo name `amrita-agent` under your personal account? Public from the first commit, or public at Phase 6?
5. **Telegram**: create a fresh bot for Amrita (recommended — keeps Hermes's bot untouched)?
6. **Old Amrita git history**: the abandoned rebrand still exists in `open-design-official`'s history. Fine to leave it there (Open Design stays Open Design), or do you want it cleaned?
7. **Language**: UI/docs in English only for the public repo, with Hebrew supported in conversation — correct?
8. **v1 cut confirmation**: is Telegram-before-web-UI the right priority order (Phases 3→4), or do you want web first?

---

*Prepared June 10, 2026. Sources: NousResearch/hermes-agent source tree; open-design-official git history; Anthropic Agent SDK & support docs; OpenAI Codex docs; google-gemini/gemini-cli docs & service updates; x.ai docs; OpenRouter docs; Anthropic prompt-engineering & agent-building publications.*
