# Amrita Agent अ

**A chat-first, project-aware, multi-channel agent operating system.**
Talk to Amrita from the web or Telegram. She remembers your projects, plans with you, runs tools, delegates real coding work to Claude Code, drives design tools — and keeps the whole picture in a memory vault you can open in Obsidian.

Built from scratch by [Nethanel Kol](https://github.com/Kandiga). Zero runtime dependencies — Node's built-in SQLite, fetch, and native TypeScript execution power everything.

---

## Status

Early but real — this is the first working implementation checkpoint, not a finished product.

- **Implemented and unit-tested** (32 tests): agent loop with provider failover, tool runtime with per-toolset permissions and a project-directory jail, SQLite + FTS5 memory, the project/session/binding model with markdown vaults, gateway command routing, the daemon HTTP API + magic-link auth, the cron scheduler, the context builder, the web UI, and the `amrita` CLI.
- **Implemented, not yet integration-tested** (each needs the external tool present): the Telegram network layer, the Claude Code connector (drives a local `claude` CLI), and the Open Design connector (drives a local Open Design daemon). Each degrades to an honest "not configured / not reachable" message rather than failing.
- **Not yet built**: the MCP client, the Codex and Gemini-CLI connectors, GitHub-Releases packaging for `amrita update`, vector retrieval, and multi-user support.

The `curl … install.sh` flow below works once the repository is public on GitHub.

---

## Why Amrita

Most agent tools are dashboards with a chat bolted on. Amrita inverts that:

- **Conversation is the interface.** One chat pane, a sidebar of projects and sessions. That's the whole UI.
- **Projects are the unit of memory.** Opening a project means talking to an Amrita that knows its brief, decisions, tasks, history, and current git state.
- **Connectors, not shells.** Claude Code and Open Design are optional plugins. When they work, a *lane* (console/preview panel) opens beside the chat; close it and the work continues.
- **Honest integrations.** Only official auth paths. Unconfigured shows "needs setup" — nothing is ever faked.

## Quick start

Requires Node ≥ 23.6 and git.

```bash
curl -fsSL https://raw.githubusercontent.com/Kandiga/Amrita-Agent/main/scripts/install.sh | bash

amrita setup     # provider, model, telegram — guided
amrita doctor    # verify everything
amrita daemon    # start: prints a one-time web login link
```

Or run from a clone, no install:

```bash
git clone https://github.com/Kandiga/Amrita-Agent && cd Amrita-Agent
node src/cli/main.ts chat        # terminal chat, right now
node src/cli/main.ts daemon      # web UI on 127.0.0.1:7460
```

## What it looks like

```
┌────────────┬─────────────────────────────────┬──────────────┐
│ Amrita     │  📁 secure-smart-crm            │ Claude Code  │
│            │                                 │ console lane │
│ ⌂ Main     │  you: fix the PDF export bug    │              │
│            │                                 │ ⚙ Reading    │
│ PROJECTS   │  amrita: Found it — the quote   │   export.ts  │
│ ▸ crm      │  template breaks on RTL text.   │ ⚙ Editing…   │
│ ▸ game     │  Sending Claude Code a brief…   │              │
│            │  ⚙ claude_code_run ✓            │              │
│ SESSIONS   │                                 │              │
│ · today    │  Fixed. 2 files changed, build  │              │
│ · jun 8    │  passes. Want me to commit?     │              │
│            │ ┌─────────────────────────────┐ │              │
│ ⚙ Settings │ │ Message Amrita…          ↑ │ │              │
└────────────┴─┴─────────────────────────────┴─┴──────────────┘
```

## Channels

| Channel | Status | Notes |
|---|---|---|
| Web UI | ✅ | Magic-link login, streaming, lanes, mobile-friendly, RTL-aware |
| Telegram | ✅ | `/projects` button switching, context indicator, long-polling (no inbound ports) |
| Terminal | ✅ | `amrita chat` |
| WhatsApp, Discord | planned | the adapter contract is ~6 methods |

**Telegram flow:** the default chat is *main Amrita*. `/projects` shows your projects as buttons; tap one and the conversation becomes that project's Amrita — with its memory, files, and tasks. `/where` always tells you which context you're in; `/main` goes back.

## Providers

Amrita's own brain runs on any of these (config: `amrita setup` or Settings):

- **API keys**: Anthropic, OpenAI, OpenRouter, Gemini, xAI — plus any OpenAI-compatible endpoint
- **Local models**: Ollama, llama.cpp, vLLM (OpenAI-compatible, localhost)
- **CLI passthrough** (connectors, not providers): Claude Code runs under *your* login on *your* machine — Amrita never touches its tokens

See [docs/providers.md](docs/providers.md) for the honest auth-mode map, including what we deliberately don't do (no OAuth token harvesting, ever).

## Memory

Each project gets a markdown vault at `~/.amrita/projects/<slug>/vault/`:

```
BRIEF.md          what this project is
CONTEXT.md        curated context pack — loaded into every session
DECISIONS.md      append-only decision log
TASKS.md          now / later / done
sessions/         auto-generated session summaries
```

Plain markdown, Obsidian-compatible, git-trackable. Conversations live in SQLite with full-text search; the agent searches both.

## Architecture

```
channels (web · telegram · cli) → gateway → agent core → providers
                                       ↘ tools · connectors · MCP-ready registry
        SQLite + FTS5  ·  markdown vaults  ·  cron scheduler  ·  audit log
```

One daemon, zero runtime npm dependencies. Full design doc: [docs/AMRITA_AGENT_PLAN.md](docs/AMRITA_AGENT_PLAN.md).

## Deployment (VPS)

The daemon binds to `127.0.0.1:7460`; put Caddy (or any TLS proxy) in front — see [deploy/Caddyfile.example](deploy/Caddyfile.example) and [deploy/amrita.service](deploy/amrita.service). Telegram uses long-polling, so no inbound ports beyond HTTPS.

## Security posture

- Secrets only in `~/.amrita/secrets.env` (0600) — never in the repo, the DB, or the browser
- Magic-link auth (one-time links, hashed tokens, 30-day sessions)
- Per-context toolset permissions; cron jobs always run with interactive/connector tools stripped
- Telegram is **owner-only** — deny-by-default until you allowlist your numeric user id (the bot can run shell/file tools)
- Project file tools are jailed to the project working directory (absolute paths and symlink escapes rejected)
- Delegated subprocesses (Claude Code) get a scrubbed environment — Amrita's unrelated secrets are not forwarded
- Append-only audit log of every tool call, connector launch, and config change

## Development

```bash
npm install        # dev deps only (typescript, @types/node)
npm run typecheck
npm test
```

Inspired by the architecture of [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research), Claude Code, and the MCP ecosystem — designed independently, built from scratch.

## License

MIT © Nethanel Kol
