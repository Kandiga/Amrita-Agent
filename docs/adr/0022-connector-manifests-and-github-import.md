# ADR-0022: connector manifests, the Setup Hub status model, and GitHub issue import

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** The roadmap's Setup Hub stage. The store has carried a dormant `connectors`
  table and `connector.installed/updated/removed` events since Phase 0, with no callers. The
  Settings & Runtime Hub renders a static, hand-written connectors card. Meanwhile the first
  real *source* connector — GitHub — needs a one-way issues → tasks import with provenance and
  idempotency, which the `tasks` table cannot express (no external reference).

## Decision

### 1. `ConnectorManifest` (protocol)
A connector is described by a Zod-validated manifest in `@amrita/protocol`
(`connectorManifestSchema`): `slug`, `kind` (`source | tool`), `title`, `description`,
`capabilities` (string tags), `requiredEnv` / `optionalEnv` (**env-var NAMES only**, charset-
checked — never values), `setupCommands` (exact operator commands), `docsUrl`, and
`experimental`. Manifests are **code-registered** in the daemon and parsed at registration —
an invalid manifest is a boot-time error, not a runtime surprise. The dormant `connectors`
store table is *not* used by this slice; it remains reserved for user-installed/third-party
connectors, which will arrive behind their own ADR.

Channels (web, telegram) deliberately stay **outside** the connector registry: their honest
status already lives in `channels.list` and doctor. One concept, one source of truth.

### 2. The honest status model
`connectors.status` (RPC) computes, per registered manifest:

- `needs_setup` — required env names absent (the missing NAMES are listed, with exact
  `export` commands);
- `connected` — env present **and** a live bounded probe succeeded (for GitHub:
  `GET /rate_limit` with the token — cheap, scope-free);
- `configured_but_failing` — env present but the probe was explicitly rejected
  (e.g. HTTP 401: the token is set but invalid/expired);
- `status_unknown` — env present but the probe was inconclusive (timeout/network);
  never rendered as a green state;
- `needs_install` / `experimental` — reserved in the enum for CLI-backed and pre-stable
  connectors respectively (no current connector uses them; the UI handles them).

Doctor stays synchronous and therefore **presence-only**: it reports "configured
(presence-checked only)" and points at `connectors.status` for live verification. It never
claims `connected` without a probe.

### 3. Task provenance: `externalRef` (protocol + migration 0006)
`task.created` gains optional `externalRef` (e.g. `github:owner/repo#123`) and `body`
fields — additive optional fields on a strict schema, so every historical event still parses
and replays (`body` previously required a separate `task.updated`; an imported issue carries
its URL in one event).
Migration `0006_task_external_ref` adds `tasks.external_ref` plus a **partial unique index**
on `(project_id, external_ref)`: the database itself forbids duplicate imports per project.
Reversible (`DROP INDEX` + `DROP COLUMN`).

### 4. GitHub import MVP (one-way, official API only)
`github.importIssues` (RPC) fetches open issues from `api.github.com` through the kernel's
**injected fetch** (tests use fakes; no real network in tests), authenticating with the
`GITHUB_TOKEN` env var — read at call time, held in a local, never logged/stored/echoed.
Pull requests are excluded. Each issue becomes a task titled `#<n> · <title>` with
`externalRef = github:<owner>/<repo>#<n>` and the issue URL in the body; issues whose
`externalRef` already exists in the project are **skipped** (idempotent re-import). The
import is strictly one-way: Amrita never writes to GitHub in this slice. A missing token is
a structured error naming the env var, mirrored by doctor/Setup Hub with the exact fix.

## Consequences
The Setup Hub renders real connector states from one typed registry instead of prose; fake
green is structurally impossible (`connected` requires a live probe). Tasks can now carry
provenance to any external system via `externalRef`, and the partial unique index makes
import idempotency a database guarantee rather than a convention. Re-import does not update
changed issue titles (skip-only) — sync/refresh semantics are future work, as is the
reverse direction (task → issue), which would be a separate, approval-gated ADR.
