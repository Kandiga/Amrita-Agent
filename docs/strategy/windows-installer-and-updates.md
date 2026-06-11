# Windows installer & automatic updates — implementation path

- **Date:** 2026-06-11
- **Status:** Accepted plan; **no installer exists yet and none is claimed.** Scaffold lands
  only when a real build is produced and tested.
- **Context:** Amrita today = React/Vite web app (`apps/web`) + Node/TypeScript daemon
  (`amritad`, localhost HTTP/WS, bearer token) + SQLite via **better-sqlite3 (native addon)**.
  CLI/daemon mode must survive forever; the installer is an *additional* way in.

## Shell decision: Electron (recommended) vs Tauri

| Concern | Electron | Tauri |
|---|---|---|
| Node daemon + better-sqlite3 | runs unchanged (Node is in-process; daemon forks as a child) | needs a **Node sidecar binary** (negates the size win) or a Rust rewrite of the daemon |
| Bundle size / RAM | heavier (Chromium bundled) | ~10× smaller, ~5× less RAM — *if* no Node sidecar |
| Auto-update | `electron-updater` (mature, NSIS-aware) | built-in signed updater (keypair, verify-before-apply) |
| Rendering consistency | identical Chromium everywhere | OS WebView (WebView2 on Windows — fine; older OS drift risk) |
| Team fit for this repo | TypeScript end-to-end | Rust layer added to the stack |

**Recommendation: Electron for the Windows MVP.** The daemon is the product's spine and it is
Node + a native addon; Electron is the only path where it ships unmodified. Revisit Tauri only
if the daemon is ever compiled to a standalone binary (Node SEA/pkg), which would make
Tauri + sidecar credible. (Tradeoffs per current ecosystem sources: Tauri's updater signs and
verifies by default; Electron native-module support is direct; see research links in the
upgrade ledger session notes.)

## Staged delivery

- **W0 (free, anytime):** "portable mode" doc — `pnpm amritad -- --http` + browser, exactly
  today's smoke. Zero new dependencies.
- **W1 — Electron shell MVP (Windows):** a new `apps/desktop` workspace package. Main process:
  spawn `amritad` (`--http --port 0`, capture the printed port + generated token), open a
  BrowserWindow on the built web app, inject the token via a preload-managed handshake (never
  query strings, never localStorage from the main world), kill the daemon on quit. NSIS
  installer via electron-builder.
- **W2 — auto-updates:** electron-updater against a release feed; **signed builds only**
  (Windows code-signing cert), staged-rollout channel (`latest` / `beta`), verify-before-apply,
  automatic rollback to the previous version on a failed health check after update, fully
  functional offline (update check is best-effort, never blocking).
- **W3 — macOS/Linux + public site:** download page on the Amrita domain with per-OS buttons,
  docs, changelog. Explicitly **not** in scope now; the path is: W2 artifacts + a static site.

## Windows runtime layout

| What | Where |
|---|---|
| App binaries | `%LOCALAPPDATA%\Programs\Amrita` (per-user NSIS; no admin required) |
| SQLite DB | `%APPDATA%\Amrita\amrita.db` (WAL files beside it) |
| Spilled artifacts | `%APPDATA%\Amrita\artifacts\` |
| Logs | `%APPDATA%\Amrita\logs\` — rotating, **never** containing the bearer token or any secret |
| Config (non-secret) | the `settings` table (already tripwired against secret-ish keys) |
| Secrets | env / OS credential store (DPAPI-backed keychain as an additive backend later); the DB stores env *names* only (ADR-0003) — unchanged |

## Daemon lifecycle & security

- Daemon binds **loopback only** (today's default `127.0.0.1` stays). No firewall prompt for
  loopback; document the WebView2/localhost nuance.
- Token: generated per app session by the existing `resolveAuthToken` path, passed to the
  renderer through the Electron preload bridge (contextIsolation on, nodeIntegration off),
  never written to disk.
- Crash behavior: if the daemon exits, the shell shows an honest "runtime stopped" state with
  the log path and a restart button — no silent respawn loops (max 3 restarts, then surface).
- Dev mode vs installed mode: dev = Vite proxy + manual daemon (today, unchanged); installed =
  shell-managed daemon + built assets. A single `AMRITA_MODE` env distinguishes them in logs.

## First-run wizard

Backed entirely by the existing `doctor` report (no new truth source): welcome → where data
lives → runtime checks rendered from doctor sections (providers needs-setup with exact
commands, Claude Code installed/logged-in via the lane runner's probe, lanes posture) → open
the first project. The wizard *shows* `needs_setup` honestly; it never fakes readiness.

## CI/release path

GitHub Actions: build web → build shell → sign → attach NSIS + latest.yml to a GitHub release
→ electron-updater feed points at releases. Native-addon rebuild (`better-sqlite3`) pinned via
`electron-rebuild` against the shell's Node ABI. A release smoke job installs the artifact in a
Windows runner, boots it headless, and asserts `/health` + one authenticated RPC.

## What is intentionally NOT claimed yet

No `apps/desktop` package exists; no installer has been built; no updater channel exists; no
code-signing cert is provisioned. Adding electron/electron-builder dependencies is deferred to
the W1 phase so today's workspaces stay lean. This document is the contract for that phase.
