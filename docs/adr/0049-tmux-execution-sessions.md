# ADR-0049: tmux-hosted execution sessions

- **Status:** Accepted
- **Date:** 2026-07-15
- **Builds on:** ADR-0048 (orchestration layer), ADR-0039 (lane workspace jail), ADR-0021 (approval),
  ADR-0015 (lane exit states)

## Context

The existing lane runners (`ClaudeCodeLaneRunner`, `CodexLaneRunner`) are **headless one-shot**:
they spawn `claude --print`/`codex exec` through a detached process group, parse `stream-json` into
progress, and return one `MergeReport`. This is right for autonomous, tightly-budgeted, CI-safe work
— but the operator wants to **manage Claude Code and Codex through tmux**, watch them live, run them
in parallel (build + cross-QA + model comparison), and keep session state out of daemon process
memory (owner decision, 2026-07-15). A tmux session **outlives the daemon**, which the headless
child cannot — its stdout is unrecoverable after a restart.

Verified on this host: `tmux 3.4`, `claude 2.1.209`, `codex-cli 0.144.1` are all present.

## Decision

1. **A new `LaneRunner` kind, not a new orchestration path.** `TmuxSessionLaneRunner` (kinds
   `claude-code-tmux` / `codex-tmux`, one parameterized runner instantiated twice) registers exactly
   like `codex`/`research` and satisfies the same `run(mandate,{signal,onProgress}) → MergeReport`
   contract. It resolves only when the session ends (agent exits / operator finishes / wall-clock or
   idle budget / cancel). `startLane`/`runLaneToCompletion` are unchanged.

2. **An injectable `TmuxController`** (`tmux.ts`, node impl + `FakeTmuxController` for CI):
   `newSession`, `hasSession`, `capturePane`, `sendKeys`, `killSession`, `listSessions` — fixed argv,
   no shell. Preflight is honest-or-abort: `tmux -V` present, chosen agent `ready`
   (`getCodingRuntimes`), cwd within `allowedRoots`; any failure → `MergeReport exit:'aborted'` with
   the exact `nextCommand`, never a fake session.

3. **Observation is split by trust.** The raw pane (`tmux capture-pane`) is streamed to the Canvas as
   a **stream-only `lane.pane` event** (like `model.delta`, never persisted) via a new
   `LaneRunContext.onPane?` hook. Persisted `lane.progress` is coarse and **regex-redacted**
   (secret-shaped content stripped). Machine truth comes from **workspace files** (already served by
   the ADR-0039 workspace route + `captureMergeReport`), not from pane text — a full-screen TUI
   capture is a noisy snapshot, not an event log.

4. **Interaction.** `lanes.session.send` → `tmux send-keys -l` (literal mode, injection-guarded) so
   the operator or Amrita can answer a prompt or redirect mid-session; `lanes.session.finish` ends a
   session and assembles the report from a deliverable file → workspace enumeration → clamped pane
   fallback.

5. **Durability = re-attach.** Additive-optional `lane.spawned.session? {host:'tmux', name, agent,
   model?}` + nullable `lanes.session_name/agent/model` columns. On boot, `reconcileLanesOnBoot`
   (ADR-0048) re-attaches a tmux session when `tmux has-session` is true (the same `run()` attaches
   instead of `new-session`), and honestly aborts it (`origin:'system'`) only when the session is
   gone. `close()` on shutdown must **not** abort durable (tmux) lanes — it leaves them running for
   re-attach — while `cancelLane` still `kill-session`s.

6. **Parallel + cross-QA correlate via the lanes row, no new table.** Additive-optional
   `lane.spawned` fields + nullable columns `group_id` / `role` (`build|qa|compare`) /
   `verifies_lane_id`. A Codex QA lane is spawned with `scope.paths = [buildLane.workspace]` and
   `verifies_lane_id = buildLane.id`. The `LaneMandate` stays strict/pristine — this is orchestration
   metadata, not scope.

## Consequences

**Honest limits, stated not hidden:** interactive tmux drops the headless read-only `--allowedTools`
guard, so enforcement is the jailed cwd + the agent CLI's own permission model + operator vigilance —
**safe only while attended**; therefore autonomous delegation defaults to headless and tmux sessions
are operator-initiated or gated (ADR-0048 §7). Live `maxTokens`/`maxUsd` budget is **not enforceable**
in interactive mode (only wall-clock + idle); token/usd are advisory. `kill-session` is a weaker kill
than the headless process-group SIGTERM→SIGKILL. `--dangerously-skip-permissions` is never passed.
Secret-in-pane redaction is best-effort; the operator's own browser can see a live secret (equivalent
to `tmux attach`) but it never enters the store. tmux is Unix-only; absent hosts get an honest
"needs setup". The two modes are complementary — tmux stronger on durability/observability/interaction,
headless stronger on budget/enforcement/machine-truth.
