# ADR-0026: Hermes-grade setup, provider registry, runtime registry, and doctor

- **Status:** Accepted
- **Date:** 2026-06-13
- **Context:** ADR-0024/0025 gave Amrita a one-line installer, a first-run wizard, and a
  catalog-driven brain chooser. A deep read of Hermes Agent's install/setup/provider/auth/
  doctor architecture (`docs/strategy/hermes-install-architecture-study.md`, with file:line
  citations) showed Amrita was still shallow on: sectioned/idempotent setup with first-vs-
  existing flows, a shared model command, provider transport/alias/discovery depth, a typed
  config layer with backup + permission hygiene, a generalized runtime registry, and a doctor
  that is the single grouped truth source. This ADR closes that gap on Amrita's existing seams,
  with no protocol or store-schema change.

## Decision

### 1. Typed non-secret config layer + permission hygiene (`@amrita/daemon` `home.ts`)
`~/.amrita/config.json` (typed `AmritaConfig`, atomic 0600) holds non-secret operator state
(`setupComplete`, `lastSetupAt`, `preferences`). `backupBeforeReconfigure(stamp)` copies
`config.json` + `secrets.env` to `*.bak.<stamp>` before a reconfigure. `checkPermissions()` /
`fixPermissions()` enforce home 0700 and secret/config 0600. Secret VALUES still never leave
`secrets.env`; the store still holds env-var NAMES only.

### 2. Sectioned, shared setup (`packages/cli/src/setup.ts`)
`SETUP_SECTIONS` registry (`brain, roles, runtime, channels, service, agent, tools`).
`amrita setup` runs quick essentials (brain + channels) on first run; `amrita setup --full`
reconfigures every section (with backup); `amrita setup <section>` edits one. `amrita model` is
the shared brain flow (same `sectionProvider` the wizard runs). Non-TTY prints section-specific
`nonInteractiveGuidance(section)`. The agent section can opt into real lane execution by writing
`AMRITA_LANES_ALLOW_REAL_EXECUTION` to `secrets.env`.

### 3. Provider registry depth (`provider.ts`)
`RealProviderSpec` gains `transport` (`anthropic_messages | openai_chat | cli_json |
local_openai`), `baseUrlEnvVar` (runtime base-URL override), curated `models`, and
`supportsModelDiscovery`. `PROVIDER_ALIASES` + `normalizeProvider()` canonicalize human names
(`claude→anthropic`, `ollama→local`); applied in role binding and chat resolution.
`probeOpenAiModels()` + `suggestV1BaseUrl()` power live `/models` discovery and the local `/v1`
hint. `kernel.discoverModels()` (live → curated fallback) and `kernel.probeEndpoint()` back the
new `providers.models` / `providers.probeEndpoint` RPCs.

### 4. Generalized runtime registry (`runtimes.ts`)
`CODING_RUNTIMES` (`claude-code` wired; `codex`, `opencode` detection-only) + `getRuntimesStatus()`
probe every runtime with bounded timeouts. Claude Code keeps its full install+auth probe;
detection-only runtimes report presence honestly and never claim runnability.

### 5. Doctor as the grouped truth source (`doctor.ts`)
`runDoctor` is now async and ordered `home → store → providers → runtimes → lanes → channels →
connectors → auth`. New groups: home/config/secrets (paths + permission failures with
`amrita doctor --fix`) and runtimes (live CLI states). `--fix` performs only safe permission
remediation. Every warn/fail still carries an exact fix; secrets never appear in the report.

## Consequences
- New CLI: `amrita model`, `amrita setup <section>`, `amrita setup --full`, `amrita doctor --fix`,
  `amrita provider catalog`, `amrita provider models <id>`. New RPCs: `providers.models`,
  `providers.probeEndpoint`.
- No protocol/store change; `secrets.env`-as-values + names-in-store invariant preserved; mock
  fallback preserved.
- Streaming stays honestly `false` for real adapters; codex stays detection-only.

## Intentionally deferred (honest scope)
- models.dev live catalog ingestion (curated lists today; discovery probes the live endpoint).
- Credential pool/rotation and OAuth execution (codex) — modeled as seams, not faked.
- Cross-init service abstraction (systemd/s6/launchd/Windows) — Linux/WSL systemd is wired;
  the rest is installer/strategy-doc territory.
- Web Setup Hub still renders the older provider list; pointing it at `providers.catalog` is the
  next slice.
