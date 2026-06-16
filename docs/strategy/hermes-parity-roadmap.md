# Hermes-grade parity roadmap (living map)

A living, repo-grounded comparison of **Hermes Agent** (read-only reference at
`/usr/local/lib/hermes-agent`) against **Amrita v2**, across the full operational skeleton:
install → setup → config → auth → providers/models → daemon → gateway/channels → memory →
tools/skills/MCP/webhooks/connectors → cron → doctor → web Setup Hub → docs.

This is **not** a plan to copy Hermes. Hermes is architecture inspiration; Amrita keeps its own
identity, typed/schema-first/event-sourced style, and its stricter secret rule (the store holds
env-var **NAMES** only; secret VALUES live only in `~/.amrita/secrets.env`). Where a row says
"planned" it means *honestly not implemented yet* with the exact next step — never a fake state.

How to read each row: **Hermes capability → Amrita current state → gap → target Amrita shape →
implementation slice → verification gate.** Each is tied to concrete repo paths and CLI/RPC/web
surfaces so the map stays falsifiable.

Status legend: ✅ matched · 🟡 partial · ⬜ planned (not started).

---

## 1. Install / update / uninstall / service

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Installer | `hermes_cli` one-line install + prereq checks + launchers + service | ✅ `scripts/install.sh` (prereqs, clone-or-ff, frozen-lockfile, `~/.local/bin` launchers, opt-in systemd, post-install `amrita health`) | none material | keep | — | `bash -n scripts/install.sh`; temp-dir install smoke |
| Update | `hermes` self-update / ff path | ⬜ none (`amrita update` does not exist) | no update command | `amrita update` thin wrapper over the installer ff path | add `update` to `COMMANDS` registry (`packages/cli/src/commands.ts`) → calls installer in update mode | CLI test (dry path) + `bash -n` |
| Uninstall | `uninstall.py` (`hermes uninstall`) | ⬜ none | no uninstall | `amrita uninstall` dry-run/instructions first; destructive needs explicit confirm | new command; print removal plan for `~/.amrita`, launchers, service; `--yes` gate | CLI test (dry-run prints plan, removes nothing) |
| Service | `service_manager.py` detects systemd/s6/launchd/Windows; status/logs | 🟡 installer offers systemd user unit (`deploy/amritad.service`); setup `service` section + doctor print foreground/journalctl commands | no `amrita service` verb; Linux/WSL only | `amrita service status/start/stop/logs` (systemd-user first; other inits documented) | new `service` command group calling `systemctl --user`; honest "unsupported init" message | CLI test with injected exec; doctor service group |

## 2. Setup / first-run

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Sectioned setup | `SETUP_SECTIONS` + `hermes setup <section>` | ✅ `SETUP_SECTIONS` in `packages/cli/src/setup.ts` (`brain/roles/runtime/channels/service/agent/tools`); `amrita setup <section>` / `--full` | none material | keep | — | setup tests (`packages/cli/test`) |
| First-run vs existing | first-time-quick / full / quick-missing | ✅ quick essentials first run; `--full` reconfigure with backup; `setupComplete`/`lastSetupAt` in `config.json` | none material | keep | — | home + setup tests |
| Shared model flow | `setup_model_provider` == `hermes model` | ✅ `amrita model` == `amrita setup brain` (one `sectionProvider`) | none | keep | — | setup tests |
| Non-interactive | exact `config set` guidance when headless | ✅ `nonInteractiveGuidance(section)` | none | keep | — | setup test (headless refuse) |

## 3. Config command layer

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Config CLI | `config.py`: `path/show/set/edit/check/migrate` | ✅ `amrita config path/show/set/check` (`packages/cli/src/config-cli.ts`); non-secret only — secret-like keys **and** secret-shaped values refused → pointed at `secrets.env`/`amrita setup`; backup-on-overwrite | `edit`/`migrate` not built (config schema v1, no migration owed) | keep; add `edit`/`migrate` only when a real need appears | done (ledger Phase 16): CLI e2e + pure-guard unit tests |
| Backup | `config.yaml.bak.<ts>` before changes | ✅ `backupBeforeReconfigure(stamp)` | none | keep; reuse in `config set` for destructive edits | — | home test |
| Permissions | `--fix` chmod hygiene | ✅ `checkPermissions/fixPermissions` (0700/0600) via `amrita doctor --fix` | none | keep | — | doctor test |

## 4. Auth / credential / account layer

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Accounts | per-provider accounts in `auth.json` | 🟡 `account connect/bind-secret/status` (store rows; env-NAME refs only) | no `account list/remove` | `amrita account list/remove` symmetric with connect | add list/remove to `COMMANDS` over existing store account APIs | CLI tests |
| Secret separation | tokens in `auth.json`, config in `config.yaml` | ✅ stricter: VALUES only in `secrets.env` (0600); store/config hold NAMES | none (Amrita exceeds) | keep | — | secret scan |
| Credential pool | `credential_pool` peek/pop + suppression | ⬜ single key per provider | no rotation | account model already supports many accounts/provider → additive pool later | ADR for pool/rotation; then store/kernel rotation seam | ADR + tests when built |
| OAuth/device-code | `oauth_device_code/oauth_external/external_process` | 🟡 modeled honestly: codex detection-only; `subscription_cli` (Claude Code) real | no device-code exec | device-code seam for providers that support it; codex exec after verifying CLI contract | ADR-gated; keep detection-only until verified | live probe evidence |

## 5. Providers / models / role binding

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Catalog | models.dev + overlays + user config | 🟡 `REAL_PROVIDERS` render-from-metadata catalog; `providers.catalog` RPC with live bounded probes; honest states | no models.dev ingestion | keep curated + discovery; models.dev optional later | (deferred) models.dev ingest behind a flag | catalog tests |
| Aliases | `ALIASES` normalize names | ✅ `PROVIDER_ALIASES`/`normalizeProvider` | none | keep | — | provider-registry test |
| Transport | 4 transports → wire behavior | ✅ `ProviderTransport` (anthropic/openai/cli_json/local_openai); one OpenAI-compat adapter | none material | keep | — | adapter tests |
| Model discovery | live `/v1/models` + fallback | ✅ `discoverModels`/`probeEndpoint` → `providers.models`/`providers.probeEndpoint` | none | keep | — | discovery tests |
| Role binding | model roles | ✅ `resolveRole` project>global>auto; `amrita role set/clear/list` | none material | keep | — | role tests |

## 6. Daemon lifecycle

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| HTTP/WS + token | gateway server + auth | ✅ `amritad` HTTP `/rpc` + `/events`, bearer-token gated; `amrita health` | none material | keep | — | live HTTP smoke |
| DB open hardening | — | ✅ migrate-up write-lock, structured `store_open_failed`, concurrent-first-run safe | none | keep | — | store tests |
| Stable token | — | 🟡 token generated; doctor warns if not set for stable use | ensure setup wires a persistent token | confirm `service`/`agent` setup writes a stable token guidance | verify in setup `service` section | doctor daemon group |

## 7. Gateway / channels

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Channel model | gateway = platform adapters + lifecycle + delivery | 🟡 web transport (always) + Telegram operator runner (`amritad --telegram`, owner-gated long poll); `channels.list` honest readiness | no unified gateway ADR; no channel verbs beyond list/pair | ADR defining Amrita gateway architecture; `amrita channel` status/start instructions | strategy/ADR section; surface channels in doctor + web honestly (already partial) | doctor channels group; ADR |
| Telegram | full bot | ✅ live operator runner (status/lanes/approvals/approve/deny/stop), injectable fetch, refuses unconfigured | none material | keep | — | channels tests; live getMe in setup |
| Future channels | many platforms | ⬜ none | only web+telegram | documented-future behind same runner contract | docs only until built | — |

## 8. Memory

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Memory store | project/user memory, import/export | 🟡 `memory.put/search` RPC + CLI; event-sourced; project+user scopes; brand memory (ADR-0020) | no import/export; not surfaced in doctor/setup as a group | ADR defining Amrita memory taxonomy (project/user/runtime); doctor `memory` group; export/import commands | ADR first; then doctor group + `amrita memory list/export` | ADR; doctor memory group; CLI tests |
| No secrets in memory | — | ✅ value-free; schema-parsed | none | keep | — | secret scan |

## 9. Tools / skills / MCP / webhooks / connectors

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Connector registry | `mcp_*`, `tools_config`, `webhook`, `skills_*` | 🟡 `connectorManifestSchema` + `connectors.status` (GitHub live probe); web Setup Hub card; doctor connectors group | tools/skills/MCP/webhooks not implemented | one registry concept (id/kind/title/capabilities/requiredEnv NAMES/setupCommands/docsUrl/status probe); CLI list/status; web card; doctor | extend manifest registry to MCP/tool/webhook kinds (honest "planned" states); ADR for MCP connector support | manifest schema tests; doctor; web |
| GitHub import | — (Amrita-specific) | ✅ one-way idempotent issues→tasks | none | keep | — | import tests (no network) |
| MCP | MCP catalog/picker | ⬜ not implemented | no MCP runtime | ADR-gated MCP connector support (Apify MCP is a candidate use case, not yet built) | ADR; then connector kind `mcp` | ADR + tests when built |

## 10. Cron / background jobs

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Cron | `cron.py` schedule/list/tick | ⬜ none | no scheduled jobs | evaluate need; if built, event-sourced jobs with doctor visibility | ADR first (is it in scope for v2?) | ADR |

## 11. Doctor (single grouped truth source)

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Grouped doctor | ~8–10 groups, fix-bearing | ✅ async grouped `home→store→providers→runtimes→lanes→channels→connectors→auth`; `--fix` perms-only | missing dedicated `memory`, `service/update`, `daemon/token` groups | add memory + service/update + daemon-token groups; keep every WARN/FAIL fix-bearing & secret-free | extend `packages/cli/src/doctor.ts` groups | doctor tests; live `amrita doctor` |
| Live vs presence | live probes bounded; env/file presence-only | ✅ runtimes live-probed; connectors live-probed; provider env presence-only (labeled) | none material | keep; label every probe kind | — | doctor tests |

## 12. Web Setup Hub ↔ CLI parity

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| Provider display | — (Hermes is CLI-first) | 🟡→✅ `SettingsRuntimeHub` now consumes `providers.catalog` (honest states + fix commands) in addition to `runtime.status`/`connectors.status` | role dropdown enrichment + catalog card (this slice) | Hub = same truth as CLI/daemon; honest states everywhere | **this slice** — see Phase 15 in the ledger | web api/component tests; browser smoke |
| Endpoint probe | — | 🟡 `providers.probeEndpoint` RPC exists; not yet in Hub UI | no Hub endpoint-probe input | add local-endpoint probe input to Hub | future slice | web test |

## 13. Docs / README reality

| Area | Hermes capability | Amrita current state | Gap | Target Amrita shape | Implementation slice | Verification gate |
|---|---|---|---|---|---|---|
| README | accurate quickstart | ✅ rewritten (ledger Phase 16): live Telegram operator runner, provider catalog, `amrita config`, data-locations table, expected pre-setup warnings, dev daemon token note | none material | keep current as features land | done: read against reality this session |

---

## Sequenced next slices (smallest coherent first)

1. ~~**Phase B:** Web Setup Hub consumes `providers.catalog`.~~ ✅ done *(ledger Phase 15)*
2. ~~**Phase C:** README/docs reality alignment (Telegram runner, quickstart, data locations).~~ ✅ done *(ledger Phase 16)*
3. ~~**Phase D:** `amrita config path/show/set/check` (non-secret only; refuse secret-like keys).~~ ✅ done *(ledger Phase 16)*
4. **Phase E (next):** Doctor adds `memory`, `service/update`, `daemon/token` groups.
5. **Phase I:** `amrita service status/start/stop/logs` (systemd-user) + `amrita update`/`uninstall` (dry-run first).
6. **Phase F/G/H/J (ADR-gated):** gateway ADR, memory taxonomy ADR, connector-registry expansion (MCP/tool/webhook), credential pool/OAuth.

Every slice lands with: a real test in the same package, an ADR if protocol/store/architecture
changes, a doctor surface where it makes sense, an upgrade-ledger entry, and no fake green states.
