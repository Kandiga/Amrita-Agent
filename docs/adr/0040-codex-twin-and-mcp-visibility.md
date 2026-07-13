# ADR-0040 — The Codex twin: ChatGPT subscription as a first-class brain and lane agent

- **Status:** accepted (2026-07-12)
- **Context:** the operator has BOTH subscriptions (Claude via Claude Code login,
  ChatGPT via Codex login). Amrita must let the brain switch between them, and let
  both coding agents take delegated tasks — in parallel — under one supervisor.

## Decision

1. **`codex-cli` chat provider** (was a detection-only placeholder): chats through
   the locally logged-in `codex exec --json` session — subscription path, zero API
   keys, read-only sandbox for chat turns. Model `default` = the login's configured
   model; named ids are plan-dependent (`gpt-5.2-codex` is refused on ChatGPT
   accounts — verified live) so none are pretended. `streaming: false` is honest:
   exec emits whole `agent_message` items, never token deltas. Aliases `codex`,
   `openai-codex`, `chatgpt-subscription` → `codex-cli`; the catalog probes
   `codex --version` + `codex login status` → ready / needs_login / missing_cli.
   The setup wizard binds it as a role brain exactly like claude-code.
2. **`CodexLaneRunner` (kind `codex`)** — the safety twin of the Claude Code
   runner (ADR-0014/0015): refuses real execution unless opted in, workspace
   confinement against the same allowed roots, deny-by-default env scrub, no
   shell, `--sandbox workspace-write`, turn/minute budgets, value-free errors.
   JSONL event shapes verified live on codex-cli 0.144.1. Registered alongside
   claude-code; `activeLanes` already runs kinds concurrently, so **one Claude
   Code lane and one Codex lane can build in parallel** under Amrita's approvals,
   budgets, live event stream, and the ADR-0039 workspace canvas.
3. **Claude Code chat now streams for real**: `generateStream` via
   `--output-format stream-json --include-partial-messages` (shapes verified on
   CLI 2.1.207); assistant `text_delta`s fan out as stream-only `model.delta`,
   thinking stays backstage; catalog `streaming: true` is no longer aspirational.
4. **MCP visibility (read-only):** two `tool` connectors, `claude-mcp` and
   `codex-mcp`, report the MCP servers configured for each CLI by reading its
   config (`~/.claude.json` mcpServers / `~/.codex/config.toml` [mcp_servers]).
   Configured is reported as `status_unknown` with the exact live-health command —
   never `connected` without a probe (honest-integrations rule).

## Invariants & guards

- Runner tests: refusal-by-default, confinement, verified-JSONL parse, no-shell
  argv shape, value-free failure summaries.
- Provider tests: codex chat round-trip through injected exec (read-only sandbox,
  no `-m` for `default`); claude-code streaming delta order + buffered-exec
  fallback; catalog ready/needs_login/missing_cli states.
- MCP connectors: config-injected tests prove counts, names, and the
  configured-≠-connected rule.

## Rollback

Additive. Removing the codex catalog entry + runner registration restores the
detection-only behavior; the claude-code streaming path falls back to `generate`
by deleting `generateStream`.
