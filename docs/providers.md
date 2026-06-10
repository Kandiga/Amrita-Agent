# Providers & auth — the honest map

Amrita distinguishes its auth modes and refuses to blur them. Verified against the installed CLIs and official documentation.

## Modes

| Mode | What it means | Examples |
|---|---|---|
| `auto` | Resolves at runtime to the best available provider (login → configured key → local). The safe default — a fresh install is never trapped. | (default) |
| `api_key` | You bring a key; Amrita calls the official API | Anthropic, OpenAI, OpenRouter, Gemini, xAI |
| `local_cli_login` | Amrita drives a CLI *you* logged into; the CLI owns the credentials, Amrita never reads them | **Claude Code local login** (brain), Claude Code connector |
| `local_endpoint` | OpenAI-compatible server on your machine | Ollama, llama.cpp, vLLM |
| OAuth | Only where officially offered to third parties | (none currently shipped) |

`amrita setup` groups these as **A) local subscription / login**, **B) API key / aggregator**, **C) local model** (plus **Auto**), and shows each option's cost, what it needs, and whether it's ready right now. See [setup.md](setup.md) for the full flow.

## Per provider

### Claude Code local login (`local_cli_login`) — use your subscription as Amrita's brain
- Pick **Claude Code local login (subscription / Agent SDK credit)** in `amrita setup`. **No API key is requested.**
- Amrita drives the installed `claude` CLI in headless mode (`claude -p --output-format stream-json`) under whatever login you already have — a Pro/Max subscription or the Agent SDK credit. Amrita **never reads or stores** your Claude credentials.
- Login status is probed with the official read-only command `claude auth status --json` (returns `loggedIn` / `subscriptionType`, **no token**). `amrita doctor` reports: CLI missing · installed-but-not-logged-in · logged in (plan) · credit/usage exhausted (when detectable).
- **Scope (honest):** this is a *conversational* brain. Claude Code runs its own agent internally, so Amrita disables its tools and does **not** bridge Amrita's native tool-calling through it — it answers in text. For tool-using / coding work, use the Claude Code **connector** (`claude_code_run`), which is a separate, tool-capable path.
- Set up the login itself with Claude Code's own command: `claude auth login` (and `claude auth status` to check). Amrita does not wrap or intercept it.

### Anthropic API (`api_key`)
- **Amrita's brain via key**: `ANTHROPIC_API_KEY` → official Messages API, full native tool-calling. ✅
- **What we don't do**: harvest `sk-ant-oat…` OAuth tokens for raw API calls (ToS violation), or offer "sign in with claude.ai" to other users (requires Anthropic approval).

### OpenAI / Codex
- `OPENAI_API_KEY` → official API. ✅
- **Codex local login**: planned, **not yet a selectable Amrita brain provider**. It will authenticate through Codex's own CLI (`codex login`) via the official `@openai/codex-sdk` / `codex exec`, not by reusing your ChatGPT web session. `amrita setup` lists it under group A as "planned" and does not pretend it works yet. (The `codex` CLI is not assumed installed; Amrita won't invent its commands.)

### Google Gemini
- `GEMINI_API_KEY` → official OpenAI-compatible endpoint. ✅
- **What we don't do**: route through Gemini CLI's free Google-account OAuth. Google actively detects and 429-blocks third-party software doing that (service update, March 2026).

### xAI / Grok
- `XAI_API_KEY` → official OpenAI-compatible API. ✅
- **Grok currently requires the xAI API key in Amrita; subscription login is not supported by an official local connector yet.** Subscription OAuth is partner-gated (not generally available); we don't clone partner flows. `amrita setup` labels Grok "API key only (no subscription login)".

### OpenRouter & friends
- One OpenAI-compatible adapter covers OpenRouter, Groq, Together, DeepSeek, Mistral, and any custom `baseUrl` you set in `config.json → providers`.

### Local models
- Ollama / llama.cpp / vLLM all speak OpenAI-compatible HTTP. Tool calling on local models is best-effort: Amrita repairs malformed tool-call JSON where it can.

## Where secrets live

`~/.amrita/secrets.env`, mode 0600. Never in the repo, the database, logs, or the browser. The settings UI shows only `sk-…abc` shapes.
