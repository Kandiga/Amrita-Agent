# ADR-0024: first-run onboarding — amrita home, secrets.env, setup wizard, installer

- **Status:** Accepted
- **Date:** 2026-06-12
- **Context:** Fresh-install QA proved the build works, but reaching a usable Amrita took
  SSH, hand-edited env files, and four CLI invocations with a mandatory `--db` — far below
  the bar set by Hermes Agent's installer and by Amrita v0.1's own `install.sh` + sectioned
  `amrita setup` wizard. v2 had no installer at all. This ADR adopts the proven v0.1/Hermes
  onboarding shape on v2's existing seams (`accounts.*`, `providers.role.set`, `doctor`),
  without touching the protocol or the store schema.

## Decision

### 1. The amrita home (`~/.amrita`, override `AMRITA_HOME`)
A machine-local runtime home (created 0700) holding the default database
(`amrita.db`) and the secrets env file (`secrets.env`). `@amrita/daemon` exports the
path/parse/load/write helpers (`home.ts`). Nothing in the home is ever committed, synced,
or read into the store.

### 2. `secrets.env` — machine-local env material, not store state
`KEY=value` lines, names `^[A-Z][A-Z0-9_]*$`, values forced single-line, written
atomically (tmp + rename, 0600). Both executables (`amrita`, `amritad`) load it at the
**process boundary only** — real process env always wins, the file only fills unset
variables, and in-process tests stay hermetic because `run()` never loads it. This keeps
the constitution intact: the store still holds env-var **names** only; the secret values
live in exactly one machine-local file, same as v0.1.

### 3. `--db` becomes optional everywhere
`amrita` and `amritad` default to `~/.amrita/amrita.db` (creating the home only when the
default is actually used). `:memory:` and explicit paths behave as before. Doctor fix
lines drop the `--db <PATH>` noise and lead with `amrita setup`.

### 4. `amrita setup` — sectioned, idempotent, honest wizard
Provider → Telegram → summary, mirroring v0.1. Pasted secrets use raw-mode no-echo input;
every effect goes through the same RPC methods as the individual commands, so the wizard
can do nothing the CLI cannot. Honesty rules: provider availability is re-probed after
binding and reported truthfully; the Telegram token is verified **live** against
`api.telegram.org/getMe` (5s timeout, injectable fetch, failure offers an explicit
save-anyway); non-TTY invocations refuse with the exact non-interactive equivalent
commands. Re-runs reuse the existing account per provider (no duplicates).

### 5. `scripts/install.sh` + optional systemd user service
One-line curl installer in the v0.1 shape: prereq checks (node ≥ 22.18 for native type
stripping, git, pnpm via corepack), clone-or-ff-update into `~/.local/share/amrita-v2`,
`pnpm install --frozen-lockfile` (native builds pre-approved via
`pnpm.onlyBuiltDependencies`), `amrita`/`amritad` launchers on `~/.local/bin`, and an
**opt-in** systemd user service (`deploy/amritad.service`, `--http --telegram` — honest
warn when telegram is unconfigured). The installer never asks for keys; that is
`amrita setup`'s job, after install (Hermes lesson: defer secret collection).

## Consequences
- A non-technical user goes from nothing to a working brain + Telegram in:
  `curl … | bash` → `amrita setup` → done. Every step re-runnable.
- No protocol/store change; no new RPC methods. The wizard is a pure client.
- `amritad` with no `--db` now persists to the home DB instead of `:memory:` — the old
  default was a footgun outside tests; tests always pass `--db` explicitly.
- Windows remains the strategy-doc track (Electron, W1); this ADR covers the
  Linux/macOS/WSL CLI path that must be preserved forever anyway.
