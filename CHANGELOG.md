# Changelog

Release receipts for the v2 line — one entry per tag; the narrative receipts live in
`docs/progress/amrita-v2-upgrade-ledger.md` (two views, one commit history).

## Rollback recipe

1. `git checkout <previous tag>` in the install dir (`~/.local/share/amrita-v2`).
2. Reversible store migrations: `packages/store/migrations/*.down.sql` run through
   `migrateDown(db, <target version>)` — back up `~/.amrita/amrita.db` first.
3. `systemctl restart amritad` (or `systemctl --user restart amritad` for user installs).

## v2.0.0-alpha.1 — 2026-07-12

The reorganization release: roadmap stages R0–R6 of
`docs/strategy/reorganization-master-plan.md`, executed after the full root-cause audit
(`docs/AMRITA_ROOT_CAUSE_AUDIT.md`) and Hermes research
(`docs/HERMES_INSPIRATION_RESEARCH.md`).

- **R0 · ADR-0032** — wire-contract closure: the protocol owns RPC envelopes, result
  schemas for every method, and the real WS frame union; web parses everything; shared
  enums single-sourced; `.claude/rules/` tracked; branch/spec/ledger governance fixed.
- **R1 · ADR-0033/0034/0035** — conversation compression as lineage; bounded read-only
  project context probes (git + files); the skill registry (system/shared/project tiers,
  manifest + permissions + docs mandatory).
- **R2** — kernel operator-command service (one interpreter for every channel);
  deterministic channel-session resolver; Telegram Bot-API JSON parsed at the boundary;
  cinema mandates extracted from the kernel.
- **R3 · ADR-0036** — Global Amrita: reserved system project, `system.health/audit/plan/
  manage`, minimal typed scheduler with a silent-on-success health watchdog and a
  two-signal heartbeat.
- **R4** — the lane console window (live progress over the lane contract) with honest
  plan/ask/auto mode control (`plan` stated as unsupported, never faked).
- **R5** — design runtime: the `design-page` artifact — deterministic brand-aware page
  design, interactive inside the zero-network sandbox, hash-approval lifecycle.
- **R6 · ADR-0037, migration 0007** — WhatsApp adapter behind one shared channel flow;
  `whatsapp` channel enum; `operator.command` RPC + `amrita op` terminal parity;
  executable one-brain fitness test.

Gates at tag: root 425/425 · web 70/70 · typecheck/lint clean · live smoke on a real
daemon · deployed via `scripts/install.sh` + systemd `amritad` (`--http --telegram
--scheduler`) and live-QA'd on the host.
