# ADR-0055: Evidence-based done — typed acceptance criteria + machine verification

- **Status:** Accepted
- **Date:** 2026-07-16
- **Builds on:** ADR-0044 (board), ADR-0045 (lane proposes / human disposes),
  ADR-0048 §8.4 (confidence-gated transitions), ADR-0021 (approvals)

## Context

A delegated task ends today as a *proposal for review* — `done` is still belief.
Natanel's harmony directive: typed acceptance criteria the system checks itself
(tests/gates/file-exists), so `done` becomes evidence-based. GitHub evidence
(merged PR) follows with CONN-1.

## Decision

**Criteria are typed, closed, and machine-checkable where possible** (protocol
`acceptanceCriterionSchema`, a discriminated union grown only by ADR):
`file` (path must exist under the project's bound working folder), `command`
(gate command must exit 0 there), `manual` (human judgement — never machine-run).

**Where they live:** on the TASK (migration 0019: nullable `acceptance_json`,
`verified_at`, `verification_json`), written only via `task.updated`'s new
additive-optional `acceptance`/`verification` fields — the single write path;
every pre-0055 event replays byte-identically.

**How verification runs** (`tasks.verify`, kernel `verifyTask`):
- `file` checks are READ-ONLY, resolved inside the project root and refused on
  escape (an escape is an honest failed result, never a silent skip).
- `command` checks NEVER run silently: one deny-by-default operator approval per
  run (`task.verify` action), then `/bin/sh -c` in the project root with the
  ADR-0039 scrubbed env, a hard wall-clock kill, and **output discarded** — only
  exit codes enter the record (events stay value-free). Injectable `verifyExec`
  keeps tests hermetic.
- `manual` criteria are excluded; an all-manual list can never machine-pass
  (no vacuous evidence).
- The outcome is sealed as `task.updated.verification` → the row's
  `verification_json`/`verified_at` via projection. Derived, replayable, audited.

**How evidence gates transitions** (upgrades ADR-0048 §8.4): the pure
`resolveTaskTransition` now takes a `CriteriaState`
(`none | unverified | verified-pass | verified-fail`) derived from the task's
criteria + latest run (pre-0055 tasks fall back to the mandate's deliverables as
`unverified`):
- `verified-fail` → a BLOCKED proposal even on a `done` exit — evidence beats prose.
- `verified-pass` + auto flag → the auto REVIEW annotation now carries evidence;
  still NEVER a silent `done`.
- `unverified` → the proposal nudges "run the verification, close on evidence".

**Web:** criteria chips + add/remove editor and a Verify button per task
(TasksPanel, pure `task-evidence.ts` helpers), evidence badge ✓/✗ with check
counts and the verification timestamp.

## Consequences / limits (honest)

- Command output never enters the store — a failing check says `exit 1`, and the
  operator reruns the gate in a console/session to see why.
- Verification is a snapshot: criteria edited after a run do not invalidate it
  automatically (the badge shows the run's time). A staleness guard can follow.
- `done` itself remains a HUMAN act everywhere; evidence changes what the human
  is told, and what may auto-advance to *review*.
