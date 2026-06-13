# ADR-0025: provider catalog — multi-auth-mode brains, chooser metadata, honest states

- **Status:** Accepted
- **Date:** 2026-06-12
- **Context:** First-run QA judged the ADR-0024 wizard below the bar: it offered only two
  providers, API-key only — far from the v0.1/Hermes chooser (subscription login, gateway
  keys, local models). The miss was an incomplete implementation, not a technical limit:
  the protocol already modeled `authMode: api_key | subscription_cli | local_endpoint |
  oauth` (ADR-0003), the kernel had an injectable `CommandProber` with a real Claude Code
  install/auth probe, and `accounts`/`settings` could hold everything needed. The wizard
  had simply been scoped to the kernel's two-adapter registry instead of expanding it.

## Decision

### 1. `REAL_PROVIDERS` becomes a metadata catalog
Each spec carries `title`, `group` (`login` / `api_key` / `local`), `authMode`,
`defaultModel`, and per-mode fields (`envName`+`keyUrl`, `baseUrl`, `detectCli`+
`installHint`), plus `executable`. **UI surfaces render FROM this metadata** — adding a
provider is a catalog entry, never bespoke wizard/web code. `executable: false` marks
entries Amrita can detect but not run (codex today): they render honestly unavailable
with the reason, and `chat.turn` refuses them with the same words. Nothing silently
disappears, nothing pretends.

### 2. Seven providers, three connection modes
- **claude-code** (login): chat runs through the locally logged-in Claude Code CLI —
  `claude -p --output-format json --model <m>`, stdin transcript, JSON result parsed
  (verified against Claude Code 2.1.x). The user's SUBSCRIPTION session; no API key
  exists anywhere in Amrita. Injectable `CliExec` (KernelOptions.cliExec) keeps tests
  spawn-free; errors are classified (logged-out → "run `claude` once"), never echoed.
- **codex** (login, detection-only): detected via `codex --version`; honestly marked
  "cannot run chat through it yet — use an OpenAI API key or OpenRouter today".
  Execution lands only when it can be implemented against a real, testable contract.
- **anthropic / openai / openrouter / gemini** (api_key): one OpenAI-compatible adapter
  whose `baseUrl` includes the version segment (`/v1`, `/api/v1`, `/v1beta/openai`) so
  OpenRouter and Gemini's documented compat surface are first-class, not hacks.
- **local** (local_endpoint): any OpenAI-compatible server (Ollama/vLLM/LM Studio).
  Non-secret config `{baseUrl, model, keyEnv?}` lives in settings under
  `providers.endpoint.local`; the optional key stays an env NAME, value read at
  construction only.

### 3. `providers.catalog` RPC — live, honest chooser states
Async catalog with bounded CLI probes (reusing the ADR-era `CommandProber`):
`ready | needs_key | needs_login | missing_cli | needs_endpoint | unavailable`, each
with a human `detail` and an exact `fix`. `ready` requires real evidence (env presence,
live CLI auth probe, endpoint config). `providers.list` stays sync/presence-only and
gains the catalog metadata fields; doctor collapses an entirely-unconfigured brain into
ONE summary warning (`amrita setup`) instead of a warn-per-provider wall.

### 4. Wizard renders the catalog
Grouped chooser (Subscription/login → API key → Local) with per-entry state marks and a
recommended default (first `ready` entry, else anthropic). Choice loop with back/retry:
unavailable picks explain themselves and return to the menu; invalid input re-asks; an
optional model prompt overrides the default via the role binding. Re-running the wizard
is the supported way to CHANGE brains.

## Consequences
- No protocol or store schema change — ADR-0003's authMode enum finally earns its keep.
- The chat surface stays one seam (`ChatProvider`); subscription and local paths get the
  same structured errors, role bindings, and provenance as API keys.
- Streaming stays `false` (honest) for all real adapters until SSE lands.
- Codex execution is explicitly deferred, not faked; when implemented it must follow the
  claude-code pattern (injectable exec, classified errors, verified output contract).
