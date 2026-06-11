# ADR-0015: opt-in real Claude Code lane execution

- **Status:** Accepted
- **Date:** 2026-06-11
- **Context:** ADR-0014 established the lane runner boundary with **real execution refused by default**.
  WO#5.2 turns that foundation into a usable, gated path that can actually run a Claude Code coding
  lane locally, plus a web Lanes panel. Running a coding agent is dangerous (arbitrary processes,
  secret exfiltration, runaway cost, filesystem reach), so this ADR fixes the safety model for the
  opt-in.

## Decision

### Opt-in is explicit and layered
- **Daemon gate:** `AMRITA_LANES_ALLOW_REAL_EXECUTION=1` or `AmritaKernel.open({ allowRealLaneExecution })`.
  Off by default. When off, the kernel's lane runner is a `ClaudeCodeLaneRunner` that refuses real
  execution, so any non-dry start ends safely as `aborted` (the ADR-0014 behavior).
- **Per-request intent:** `lanes.start` accepts `real: true`. Requesting `real` on a daemon that has
  **not** opted in returns a clear, safe report (`aborted`, "real execution is disabled…") **without
  running** — never a crash. Tests assert this.
- **Dry-run stays dry:** `dryRun` records `lane.spawned`/`lane.mandate` and runs nothing.

### The process boundary is hardened
`createNodeProcessRunner` (packages/lanes/src/process-runner.ts):
- **No shell.** `spawn(file, args, options)` only — the mandate goal is one `argv` entry, so it can
  never inject a command.
- **Workspace confinement.** With `allowedRoots` set, the child `cwd` must resolve inside one of them
  or the run is refused before spawning. `ClaudeCodeLaneRunner` enforces this from
  `mandate.scope.paths[0]`; the node runner re-checks as a second guard.
- **Timeout & abort.** `timeoutMs` terminates the child (SIGTERM → SIGKILL) and marks `timedOut`; an
  aborted signal kills the child and surfaces the kill signal so the caller can map it to `cancelled`.

### Vetted command + tolerant parsing
Real runs use `claude --print <goal> --output-format stream-json --verbose --max-turns <n>
--allowedTools <narrow>`. The default `--allowedTools` is **read-only** (Read/Grep/Glob/LS); broader
tools (Edit/Write/Bash) are deferred and would require explicit mandate approval. `--output-format
stream-json` is parsed line-by-line; non-JSON/unknown lines are ignored so a CLI format drift cannot
crash a lane.

### Secrets are never forwarded
The env scrub stays deny-by-default and additionally drops every secret-shaped name. In particular
`ANTHROPIC_API_KEY` is **never** forwarded — Claude Code authenticates via its own subscription login.
No secret is printed in logs, reports, events, or UI.

### Budget covers time and turns; a new `cancelled` exit
- Time (`maxMinutes`) terminates the child; turn (`maxTurns`) counts assistant events and aborts the
  child mid-run — both map to `exit: 'budget'`.
- A manual stop maps to a **new** merge-report exit value, `cancelled`, added to `laneExitSchema`
  (`done | partial | aborted | budget | cancelled`). `cancelled` is distinct from `aborted` (failure)
  and `budget` (limit). It projects to the lane row status `aborted` (no new status column); the
  precise disposition lives in the merge report.

### Network policy is advisory, not enforced
`mandate.scope.network` is represented and reported but **NOT** OS-enforced in this WO — there is no
network sandbox yet. The runner and docs explicitly state this; we do not pretend a policy is
enforced. Real sandboxing is a future WO.

## Consequences
A local operator can enable real Claude Code lanes with one env var, observe them live (lane events
over the WS stream), and cancel them — while the default and CI paths remain exec-free. The runner,
env scrub, confinement, budget, and `cancelled` exit are stable seams; enabling broader tools or real
network enforcement are additive future WOs that don't change this surface.
