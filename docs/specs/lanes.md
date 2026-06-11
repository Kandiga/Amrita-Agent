# Spec: lanes (`@amrita/lanes`)

Status: WO#5.2 — opt-in real Claude Code execution.

A **lane** is a delegated unit of real work (e.g. a Claude Code run) launched beside a conversation.
The daemon hands a lane a `LaneMandate` (goal, scope, budget, approvals, deliverables) and the lane
returns a `MergeReport` (summary, artifacts, decisions, tasks, follow-ups, usage, exit). Those two
types are the hard contract — defined in `@amrita/protocol` (`lane.ts`); a runner never widens them.
See [ADR-0014](../adr/0014-lane-runner-foundation.md) and
[ADR-0015](../adr/0015-real-lane-execution-opt-in.md).

`exit` is one of `done | partial | aborted | budget | cancelled`, where `cancelled` is a manual stop
(operator/UI), distinct from `aborted` (a failure) and `budget` (a limit).

## Package

- Path: `packages/lanes` · Name: `@amrita/lanes`
- Depends only on `@amrita/protocol` (types + the merge-report/mandate schemas).

```
packages/lanes/src/
  runner.ts         LaneRunner / ProcessRunner interfaces, LaneSafetyError, buildReport()
  env.ts            scrubEnv() — deny-by-default child environment
  budget.ts         evaluateBudget(), BudgetGuard
  process-runner.ts createNodeProcessRunner() — spawn(file,args), confinement, timeout, abort
  stream-json.ts    parseStreamJsonLine() — tolerant NDJSON parser for real Claude Code output
  claude-code.ts    ClaudeCodeLaneRunner — text (foundation) + stream-json (real) modes
  fake.ts           FakeLaneRunner — deterministic, in-process, no exec
```

## The runner boundary

```ts
interface LaneRunner {
  readonly kind: string;
  run(mandate: LaneMandate, ctx?: LaneRunContext): Promise<MergeReport>;
}
```

`LaneRunContext` carries an `onProgress(note, pct?)` sink (the daemon forwards these to `lane.progress`
events) and an optional `AbortSignal`. Child-process execution goes through an injected `ProcessRunner`,
so the runner is fully testable without spawning anything.

## Safety model

1. **No real execution by default.** `ClaudeCodeLaneRunner.run()` throws `LaneSafetyError` unless a
   `ProcessRunner` is injected (the controlled/test path) **or** `allowRealExecution: true` is set.
   CI never sets the flag and always injects a fake runner — no Claude Code process ever runs in tests.
2. **Deny-by-default env scrub.** `scrubEnv` forwards only a short benign allowlist (`PATH`, `HOME`, …)
   plus an explicit caller allowlist, and additionally drops any **secret-shaped** name. So a child
   never inherits `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, SSH
   agent sockets, passwords, passphrases, vault/bearer vars, etc. — even if one is mistakenly
   allowlisted. A Claude Code lane authenticates via its **own subscription login**, so the daemon
   deliberately never forwards `ANTHROPIC_API_KEY`.
3. **No shell / no injection.** Args go to `spawn(file, args)` (never a concatenated shell string), so
   the mandate goal is always a single `argv` entry — `goal: "x; rm -rf /"` cannot inject a command.
4. **Workspace confinement.** When `allowedRoots` is configured, the child `cwd` (from
   `mandate.scope.paths[0]`) must resolve inside one of them, or the lane is refused before spawning
   (`exit: 'aborted'`). `createNodeProcessRunner` re-checks this as a second guard.
5. **Budget / cancel.** `evaluateBudget` bounds `maxTurns`/`maxTokens`/`maxUsd`/`maxMinutes`. A **time**
   overrun (`maxMinutes`) terminates the child (SIGTERM → SIGKILL) via `timeoutMs`; a **turn** overrun
   (counted from stream-json assistant events) aborts the child mid-run — both report `exit: 'budget'`.
   An operator **cancel** aborts the child and reports `exit: 'cancelled'`.

## Real execution (opt-in)

Real execution is gated by an explicit opt-in (`AMRITA_LANES_ALLOW_REAL_EXECUTION=1` or the daemon
option `allowRealLaneExecution`; see [runtime.md](runtime.md)). When enabled, the runner builds a
**narrow, vetted** command and parses the structured output:

```
claude --print <goal> --output-format stream-json --verbose --max-turns <n> --allowedTools Read,Grep,Glob,LS
```

- `<goal>` is one `argv` entry. The default `--allowedTools` is **read-only** (Read/Grep/Glob/LS);
  broader tools require an explicit, future, mandate-approved opt-in (print mode is preferred).
- `--output-format stream-json` is parsed line-by-line (`parseStreamJsonLine`); unrecognized or
  non-JSON lines are ignored, so a CLI format drift can't crash a lane. Assistant events become
  `lane.progress`; the terminal `result` event yields usage + a summary.

### Network policy — advisory only (not enforced)

`mandate.scope.network` (`none | allowlist | open`) is **represented and reported but NOT enforced**
in this WO — there is no OS-level network sandbox. Treat it as advisory metadata until a future WO adds
real sandboxing. The runner/docs do not claim otherwise.

## Lifecycle & events

`kernel.startLane(input)` orchestrates a lane over the existing lane protocol/projection (unchanged):

```
lane.spawned → lane.mandate → lane.progress* → lane.merge_report → lane.completed | lane.aborted
```

- `lane.spawned`/`lane.mandate` are emitted first; `dryRun` stops here (the mandate is recorded, no
  runner runs).
- A `real: true` request on a daemon that has **not** opted in emits `lane.aborted` immediately and
  does not run.
- Otherwise the lane runs. With `detach` the call returns immediately (`status: 'running'`) and the run
  continues in the background; otherwise the call awaits completion. Each progress note becomes a
  `lane.progress` event (`spawned → running`).
- The final `MergeReport` is emitted as `lane.merge_report` (`→ merging`) then `lane.completed`
  (`→ completed`) for `done`/`partial`/`budget`. An `aborted` **or** `cancelled` exit (or a thrown
  runner) emits `lane.aborted` (`→ aborted`) — the row status is `aborted`, while the precise
  disposition (`cancelled` vs `aborted`) lives in the merge report's `exit`.
- `kernel.cancelLane(laneId)` aborts a running lane (terminating its child) → `exit: 'cancelled'`. The
  kernel aborts all active lanes on `close()`.

All lane events carry `laneId` on the envelope, so the existing projection keys on it. No payload
carries a secret value.

## RPC & CLI

| Method | Params | Result |
|--------|--------|--------|
| `lanes.start` | `{conversationId, goal, kind?, dryRun?, real?, detach?, scope?, budget?, contextPack?, approvals?, deliverables?}` | `{laneId, status, dryRun, detached, report?, error?}` |
| `lanes.get` | `{laneId}` | lane row or `null` |
| `lanes.cancel` | `{laneId}` | `{laneId, cancelled, status}` |
| `lanes.list` | `{projectId?, conversationId?, status?}` | lane rows |

```bash
amrita lane list [--project ID_OR_SLUG] [--status running] --db PATH
amrita lane start --goal "tidy the repo" --project myproj --dry-run --db PATH
amrita lane start --goal "tidy the repo" --project myproj --real --db PATH   # needs daemon opt-in
amrita lane get <LANE_ID> --db PATH
amrita lane cancel <LANE_ID> --db PATH
```

Real execution is opt-in (`AMRITA_LANES_ALLOW_REAL_EXECUTION=1` / `allowRealLaneExecution`). Without it,
`lane start` (and `--real`) ends safely as `aborted`. `health.lanes.realExecution` shows the posture.

## Deferred

- Broader Claude Code tools (Edit/Write/Bash) behind explicit mandate approval; real network sandboxing
  (today `mandate.scope.network` is advisory — see ADR-0015).
- Context-pack curation and artifact merge-back into the conversation.
- Per-turn streaming budget for token/usd (turn-count and wall-clock are enforced live; token/usd are
  evaluated from the final reported usage).
