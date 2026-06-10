# Providers & auth — the honest map

Amrita distinguishes four auth modes and refuses to blur them. Verified against official documentation, June 2026.

## Modes

| Mode | What it means | Examples |
|---|---|---|
| `api_key` | You bring a key; Amrita calls the official API | Anthropic, OpenAI, OpenRouter, Gemini, xAI |
| `local_endpoint` | OpenAI-compatible server on your machine | Ollama, llama.cpp, vLLM |
| CLI passthrough | Amrita drives a CLI agent *you* logged into; the CLI owns auth | Claude Code connector |
| OAuth | Only where officially offered to third parties | (none currently shipped) |

## Per provider

### Anthropic / Claude Code
- **Amrita's brain**: `ANTHROPIC_API_KEY` → official Messages API. ✅
- **Claude Code connector**: officially documented headless mode (`claude -p --output-format stream-json`) under your own login. Since June 15, 2026, Pro/Max subscriptions meter this through a monthly Agent SDK credit — when it runs out, Amrita tells you instead of pretending.
- **What we don't do**: harvest `sk-ant-oat…` OAuth tokens for raw API calls (ToS violation), or offer "sign in with claude.ai" to other users (requires Anthropic approval).

### OpenAI / Codex
- `OPENAI_API_KEY` → official API. ✅
- A Codex connector (via the official `@openai/codex-sdk` / `codex exec`) is planned — it's the cleanest "program drives a CLI agent" SDK in the industry.

### Google Gemini
- `GEMINI_API_KEY` → official OpenAI-compatible endpoint. ✅
- **What we don't do**: route through Gemini CLI's free Google-account OAuth. Google actively detects and 429-blocks third-party software doing that (service update, March 2026).

### xAI / Grok
- `XAI_API_KEY` → official OpenAI-compatible API. ✅
- Subscription OAuth is partner-gated (not generally available); we don't clone partner flows.

### OpenRouter & friends
- One OpenAI-compatible adapter covers OpenRouter, Groq, Together, DeepSeek, Mistral, and any custom `baseUrl` you set in `config.json → providers`.

### Local models
- Ollama / llama.cpp / vLLM all speak OpenAI-compatible HTTP. Tool calling on local models is best-effort: Amrita repairs malformed tool-call JSON where it can.

## Where secrets live

`~/.amrita/secrets.env`, mode 0600. Never in the repo, the database, logs, or the browser. The settings UI shows only `sk-…abc` shapes.
