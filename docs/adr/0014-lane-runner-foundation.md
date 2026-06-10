# ADR-0014: lane runner foundation (Claude Code, safety-first)

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** The protocol already defines the lane contract (`LaneMandate`/`MergeReport`, the
  `lane.*` events, and the store projection from WO#1). WO#5.1 adds the first runtime that can drive a
  lane — a Claude Code lane — but real coding-agent execution is dangerous (arbitrary processes, secret
  exfiltration, runaway cost). This ADR fixes the **runner boundary and its safety model** before any
  real execution is wired up.

## Decision

### A separate package, depending only on the protocol
`@amrita/lanes` holds the `LaneRunner` boundary and the concrete runners. It depends only on
`@amrita/protocol` (the mandate/report types + schemas). The daemon depends on `@amrita/lanes`; the
package never imports the store or the daemon, so the runner stays a pure, injectable side-effect layer.

### The runner boundary
`LaneRunner.run(mandate, ctx?) → Promise<MergeReport>`. `ctx` carries an `onProgress` sink and an
`AbortSignal`. Child-process execution goes through an injected `ProcessRunner` interface, so a runner
is exercised end-to-end without spawning anything. `buildReport()` constructs only schema-valid
`MergeReport`s (summary clamped to 2000).

### Safety model (the core of this ADR)
1. **No real execution by default.** `ClaudeCodeLaneRunner.run()` throws `LaneSafetyError` unless a
   `ProcessRunner` is injected, or `allowRealExecution: true` is explicitly set (which uses the real
   `claude` binary). Tests always inject a `FakeLaneRunner` or a fake `ProcessRunner`; CI never sets
   the flag. **No Claude Code process runs in tests.**
2. **Deny-by-default environment scrub.** `scrubEnv` forwards only a short benign allowlist plus an
   explicit caller allowlist, and drops any **secret-shaped** name regardless. A child therefore never
   inherits `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, SSH agent
   sockets, passwords, cookies, etc. — even if one is mistakenly allowlisted (a second forbidden-pattern
   guard runs over the allowlist itself). Crucially, a Claude Code lane authenticates via its **own
   subscription login**, so the daemon deliberately **never forwards `ANTHROPIC_API_KEY`** into it.
3. **Budget guard.** `evaluateBudget`/`BudgetGuard` bound turns, tokens, dollar-ish cost, and
   wall-clock minutes (injectable clock). An overrun returns `exit: 'budget'`. The abort path is
   deterministic and unit-tested.

### Kernel orchestration over the existing protocol
`kernel.startLane(input)` emits `lane.spawned → lane.mandate`, then (unless `dryRun`) runs the injected
runner — forwarding progress as `lane.progress` — and finishes with `lane.merge_report` +
`lane.completed`/`lane.aborted`. It reuses the **existing** lane events and store projection unchanged
(`lane.progress` keys on the envelope `laneId`; a non-aborted exit, including `budget`/`partial`, ends
`completed`). The default kernel runner is a `ClaudeCodeLaneRunner` with real exec disabled, so a
non-dry `lanes.start` over RPC/CLI ends safely as `aborted` until a future WO opts in.

### RPC & CLI
New methods `lanes.start` / `lanes.get` join the existing `lanes.list`; the CLI gains `amrita lane list`
and `amrita lane start … [--dry-run]`. All payloads remain secret-free.

## Secret handling
- No lane event, RPC result, or CLI line carries a secret value. `ANTHROPIC_API_KEY` and every other
  secret-shaped variable are blocked from the child environment by construction.
- The local HTTP auth token (WO#4.3) is unrelated config and is documented in
  [runtime.md](../specs/runtime.md); it is never passed to a lane.

## Why real execution is out of scope here
The boundary, env scrub, budget guard, lifecycle events, and projection must be stable and tested before
a real coding agent is spawned. Wiring `allowRealExecution` to a vetted command line (with sandboxing,
network policy enforcement, and approval forwarding) is a later WO that builds on this boundary.

## Consequences
A later WO can enable real Claude Code execution by injecting a real `ProcessRunner` (or setting the
opt-in) without changing the kernel/RPC/CLI surface or the event protocol. Adding a new runner is a new
`LaneRunner` implementation; it inherits the env-scrub and budget guarantees by using the shared helpers.
