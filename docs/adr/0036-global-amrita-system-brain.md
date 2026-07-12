# ADR-0036 — Global Amrita: the reserved system project, System Brain verbs, and a minimal scheduler

- **Status:** accepted (2026-07-12)
- **Context:** reorganization stage R3 (`docs/strategy/reorganization-master-plan.md` §4);
  Hermes research §3/§4 (watchdog cron convention, two-signal heartbeat).

## Decision

1. **The global scope is the reserved `system` project** (slug `system`) — already the
   kernel's write-context sink since ADR-0019. Global chat is a normal conversation in
   it; zero protocol break. A first-class scope can come later via its own ADR if it
   earns it.
2. **System Brain verbs** (`daemon/system.ts`, each typed, honest, and bounded):
   - `system.health` — the doctor report + per-project brain counts + the scheduler's
     two-signal heartbeat (alive vs productive). Read-only.
   - `system.audit` — a cross-project findings sweep over existing projections
     (missing brief, unresolved questions, open risks, brain gaps). With
     `record: true`, the top findings are captured into the **system project's brain**
     as memory entries with `source: system:audit` — so global chat surfaces answer
     "what needs attention" from records with provenance. Read-mostly; the only write
     is the explicit, bounded capture.
   - `system.plan` — drafts a plan record into a TARGET project's brain
     (`source: system:plan`, kind `project-context`). Never executes anything.
   - `system.manage` — delegates a goal as a **lane** in the target project's default
     conversation, through the existing runner + approval broker (a real run still
     requires the daemon opt-in AND an operator approval — ADR-0015/0021 unchanged).
3. **Minimal scheduler** (`daemon/scheduler.ts`): an injectable-clock ticker with typed
   jobs persisted in `settings` under `scheduler.jobs` (non-secret; zod-parsed).
   Ships ONE job kind — `system-health` — following the Hermes watchdog convention:
   **silent on success, speak on failure**: it posts a `message.system` into the system
   conversation only when the doctor reports `fail` (warns are setup states, not
   incidents). Two-signal heartbeat: `lastTickAt` (alive) vs `lastSuccessAt`
   (productive), both surfaced by `system.health`. Started opt-in by the composition
   root (`amritad --scheduler`); OS supervision remains systemd's job — the daemon
   never self-restarts (Hermes anti-lesson).

## Invariants & guards

- The system project is ensured, never duplicated (kernel `systemWriteContext`).
- `system.manage` cannot bypass the lane gates; `system.plan`/`audit` writes go through
  the value-free memory path only.
- Scheduler jobs are bounded (≥ 5 min interval), deny-by-default disabled until enabled,
  and never run anything approval-worthy (job kinds are code-registered).

## Rollback

Additive: one module pair, four RPC verbs + schemas, one settings key, one bin flag.
