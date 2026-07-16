# ADR-0056: Harmony seams — channel notifications, evidence from GitHub, import ingestion

- **Status:** Accepted
- **Date:** 2026-07-16
- **Builds on:** ADR-0021 (approvals), ADR-0037 (one chat-channel flow), ADR-0036
  (scheduler), ADR-0055 (evidence-based done), ADR-0022 (GitHub import)

## Decisions

1. **Channel notifier seam (HARMONY-2).** Running channel runners register a
   notifier (`kernel.registerChannelNotifier`); the kernel stays channel-agnostic
   and calls `notifyChannels(projectId, text, opts)` — errors swallowed, a push is
   a nicety never a failure path. `requestApproval` pushes to every chat PAIRED to
   the project with inline **Allow/Deny** buttons; the callback (`apr:<id>:<verdict>`)
   re-enters through the SAME deny-by-default owner gate and resolves the real
   approval. A Telegram DM's chat id is the paired user id.
2. **Daily digest (HARMONY-2).** New scheduler kind `daily-digest` (default job,
   24h): approvals waiting / sessions running / failing checks / tasks waiting on
   the operator — DERIVED, value-free, and **silent when quiet** (the Hermes
   watchdog convention). Weekly review auto-run already existed (`project-review`).
3. **GitHub evidence (HARMONY-3 / CONN-1 phase 1).** The ADR-0055 criterion union
   grows by `github-pr {repo, number}`: verified read-only against
   `GET /repos/{repo}/pulls/{n}/merge` with `GITHUB_TOKEN` (env NAME only);
   204=merged, 404=not, anything else/no token = **unknown → honest failed check**,
   never a silent pass.
4. **Planner v2 (HARMONY-5).** A chat-delegated build now also PROPOSES its
   decomposition to the Inbox: a tracking task linked to the session + one
   proposal per mandate deliverable. Proposed, never forced (ADR-0045).
5. **Calendar ingestion by IMPORT (HARMONY-6, first slice).** `harness.importIcs`
   parses an operator-supplied .ics (pure bounded RFC-5545 subset) into Brain
   records with `calendar-import` provenance. An honest *import* source per the
   product direction — no live connector is claimed.

## Limits (honest)

- Telegram push reaches chats paired to the project; unpaired projects push nowhere.
- The digest schedule is interval-based (24h from last run), not clock-anchored.
- `github-pr` proves the PR merged — not that the merge satisfies the task.
- ICS import is one-shot; recurring sync stays a future connector (CONN-2).
