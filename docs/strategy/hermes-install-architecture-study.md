# Hermes Agent install/setup/provider architecture — study & mapping

A bounded, read-only study of Hermes Agent (`/usr/local/lib/hermes-agent`, reference only —
no code copied) to deepen Amrita v2's installer / onboarding / provider architecture. Each
lesson is tied to the concrete Amrita decision it drove (ADR-0026). Hermes is a reference
architecture, **not** a dependency; everything below was re-implemented in Amrita's idiom
(typed, schema-first, secrets-as-env-NAMES).

## Setup (hermes_cli/setup.py, main.py)

- **Sectioned registry.** `SETUP_SECTIONS` is a list of `(id, title, handler)` tuples
  (`setup.py:2904`); `hermes setup <section>` routes to one handler (`setup.py:3087`).
  → Amrita: `SETUP_SECTIONS` in `packages/cli/src/setup.ts` (`brain/roles/runtime/channels/
  service/agent/tools`); `amrita setup <section>` routes to one section; `amrita setup --full`
  runs all; default is the quick essentials (brain + channels).
- **First-time vs existing install.** Hermes detects `is_existing` from provider/env presence
  (`setup.py:3119`) and branches first-time-quick / full-reconfigure / quick-missing-only
  (`setup.py:3163-3206`). → Amrita: quick-by-default first run; `--full` reconfigure shows
  current values; section runs for targeted edits. `setupComplete`/`lastSetupAt` recorded in
  `~/.amrita/config.json`.
- **Backup before changes.** `shutil.copy2(config → config.yaml.bak.<ts>)` before any prompt
  (`setup.py:3056`), with the restore command printed at the end. → Amrita:
  `backupBeforeReconfigure(stamp)` copies `config.json` + `secrets.env` to `*.bak.<stamp>`
  (0600) before a full/section reconfigure.
- **Shared model flow, no split logic.** `setup_model_provider()` delegates to
  `select_provider_and_model()` — the same function `hermes model` calls (`setup.py:691,713`).
  → Amrita: `amrita model` and `amrita setup brain` both call the one `sectionProvider` flow;
  the picker renders from `providers.catalog`, one source of truth.
- **Reload after delegated save.** After the model picker writes to disk, Hermes
  `config.clear(); config.update(load_config())` to avoid stale-overwrite (`setup.py:722`,
  bug #4172). → Amrita avoids the class of bug entirely: every effect goes through RPC against
  the live kernel/store (no in-memory config dict to go stale).
- **Non-interactive guidance, not a broken wizard.** `is_interactive_stdin()` gate prints exact
  `hermes config set …` commands when headless (`setup.py:177`). → Amrita: `nonInteractiveGuidance(section)`
  prints the precise `amrita …` / `secrets.env` commands for the requested section.
- **Custom endpoint validation.** `_model_flow_custom()` does `/v1` hinting for local servers,
  `/models` probing, explicit API-mode selection, model pick from the probe, and persistence
  (`main.py:3580-3796`). → Amrita: `suggestV1BaseUrl()` + `probeOpenAiModels()` +
  `kernel.probeEndpoint()`; the local-endpoint setup section suggests `/v1`, probes `/models`,
  and lets the user pick a discovered model.

## Providers / models / auth (providers.py, models.py, auth.py)

- **Provider identity = merged single source of truth.** models.dev catalog + Hermes overlays
  + user config, with overlays encoding `transport`, `auth_type`, aggregator flag,
  `base_url_override`, `base_url_env_var`, `extra_env_vars` (`providers.py:1-215`). → Amrita:
  `RealProviderSpec` gained `transport`, `baseUrlEnvVar`, curated `models`, `supportsModelDiscovery`.
  (models.dev live catalog ingestion is deferred — see ADR-0026 "intentionally deferred".)
- **Aliases normalize names.** `ALIASES` maps `claude→anthropic`, `grok→xai`, `ollama→custom`
  (`providers.py:241`). → Amrita: `PROVIDER_ALIASES` + `normalizeProvider()`, applied in role
  binding and chat resolution; a test asserts no alias is dangling.
- **Transport → API mode.** Four transports (`openai_chat / anthropic_messages /
  codex_responses / bedrock_converse`) select wire behavior (`providers.py:386`). → Amrita:
  `ProviderTransport` (`anthropic_messages / openai_chat / cli_json / local_openai`); the kernel
  picks the adapter from the spec, and one OpenAI-compatible adapter (version-segment baseUrls)
  serves OpenAI + OpenRouter + Gemini-compat + local.
- **Model discovery with fallback.** Live `/v1/models` + curated snapshots + static fallback,
  multi-tier cached (`models.py:1103`, `models_dev.py:240`). → Amrita: `discoverModels()` probes
  `/models` when supported and falls back to a curated per-provider list — never an empty pick
  list, never a throw.
- **Auth is a real subsystem, secrets separated from config.** `ProviderConfig` registry with
  modes `api_key / oauth_device_code / oauth_external / external_process / aws_sdk`; tokens in
  `auth.json`, non-secret settings in `config.yaml` (`auth.py:172,580`). → Amrita keeps its
  stricter invariant: secret VALUES never enter the store/config — only env-var NAMES; the
  machine-local `secrets.env` (0600) holds values; `config.json` holds non-secret flags. OAuth
  (codex) is modeled honestly as detection-only with a future execution seam (ADR-0025/0026).
- **Credential pool/rotation.** `credential_pool` in auth.json with peek/pop + suppression
  (`auth.py:604,1214`). → Amrita: deferred (single-key per provider today); the account model
  already supports multiple accounts per provider, so a pool is an additive future step.

## Doctor (doctor.py)

- **Deep, grouped, fix-bearing.** ~8 groups (env, packages, config, auth providers, dirs/state,
  service supervision, external tools, live connectivity, tools/skills, profiles), each
  OK/WARN/FAIL with an exact fix appended to a summary list (`doctor.py:395-2049`). → Amrita:
  `runDoctor` is now async and grouped `home → store → providers → runtimes → lanes → channels →
  connectors → auth`, with a new home/permissions group (0700/0600 checks → `amrita doctor --fix`)
  and a runtimes group (live CLI probes).
- **Live vs presence-only line.** Hermes probes connectivity live (bounded, parallel, timeouts)
  but treats env/file/import as presence-only (`doctor.py:1390`). → Amrita: doctor live-probes
  coding runtimes (bounded), keeps provider env checks presence-only, and never claims a
  connector `connected` without the separate `connectors.status` probe.
- **Auto-fix only safe ops.** `--fix` does mkdir/chmod/config-rewrite, never user-choice steps
  (`doctor.py:202`). → Amrita: `amrita doctor --fix` only tightens home/secret/config
  permissions; provider/login choices stay in `amrita setup`.
- **Service awareness.** Detects systemd/s6/launchd/Windows and reports linger/supervision +
  logs command (`service_manager.py`, `doctor.py:208-298`). → Amrita: the installer offers a
  systemd user service (`deploy/amritad.service`); the setup `service` section + doctor report
  the foreground/journalctl commands. (Cross-init abstraction deferred; Linux/WSL is the wired path.)

## Runtime / tools connection map

Hermes wires install → `.env`/`config.yaml`/`auth.json` → runtime (env_loader → config load →
tool registry → provider resolution) → doctor (`doctor.py` validation chain). → Amrita's
equivalent seam: `install.sh` → `~/.amrita/{amrita.db, secrets.env, config.json}` → executable
boundary loads `secrets.env` → kernel resolves providers/runtimes → `amrita doctor` validates
the whole chain. Tools/plugins/skills/MCP are reported honestly as "not implemented in v2 yet"
in the setup `tools` section rather than faked.
