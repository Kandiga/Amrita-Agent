# ADR-0002: Open-question defaults (§11)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** The v1.0 plan (§11) left several questions open. To unblock Phase 0 without
  over-committing later phases, we record sensible, reversible defaults here. Each can be revisited
  by a follow-up ADR.

## Defaults

| Question | Default | Rationale |
|----------|---------|-----------|
| License | **MIT** | Carried from v0.1; matches the project's open posture. |
| Config/data home | **`~/.amrita`** (config, db, secrets) | v0.1 layout; familiar, single backup target. |
| Project vaults home | **`~/Amrita`** (per-project markdown vaults) | Human-facing, Obsidian-friendly, separate from machine state. |
| Primary OS targets | **Linux & macOS first**; WSL2 supported | Where the users and VPS deployments are. |
| Language / i18n | **English UI, RTL-ready** | v0.1 was RTL-aware; keep the capability, defer full localization. |
| Telemetry | **None** | No phone-home; honesty/privacy posture. Opt-in diagnostics only, later, behind an ADR. |
| Default brain | **`auto`** | Never land a fresh install on a broken provider (D5). |
| Secrets at rest | **`~/.amrita/secrets.env`, mode 0600**, never in db/log/browser | Ported from v0.1's hardened handling. |
| Daemon bind | **`127.0.0.1` only**, TLS proxy in front | No public bind; same as v0.1. |
| Id scheme | **ULID** (D10) | — |
| Spill threshold | **32 KB** (D9) | Round, comfortably above typical tool output, below log-bloat territory. |

## Non-decisions (still open, deferred to their phase)

- Exact provider catalog entries and per-role default models → Phase 1 ADR.
- WebSocket auth handshake details (magic-link → session → socket) → Phase 2 ADR.
- Telegram pairing-code lifetime and storage → Phase 3 ADR.
- Lane sandboxing mechanism (container vs worktree vs none per `approvals`) → Phase 5 ADR.

These defaults are intentionally cheap to change; nothing in Phase 0 hard-codes against them beyond
the id scheme and spill threshold, both of which are single constants.
