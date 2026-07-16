# ADR-0054: Operator console sessions — the full CLI on the project's real files

- **Status:** Accepted
- **Date:** 2026-07-16
- **Builds on:** ADR-0049 (tmux execution sessions), ADR-0050 (project-scoped Session
  Workspace), ADR-0052 (embedded interactive terminal)

## Context

ADR-0052 gave the operator a full interactive terminal per session — every /command,
the model picker, skills, MCP, arrows/Esc all work. But two constraints made it fall
short of "full access to the Claude CLI" in practice:

1. **A goal was mandatory**, and the runner auto-typed it into the pane. There was no
   way to open a *clean* CLI the operator drives from the first keystroke.
2. **Sessions opened in an empty per-lane jail** (`<allowed-root>/<laneId>`), never in
   the project's bound working folder — so the full CLI ran on an empty directory and
   its tools had nothing real to operate on.

Natanel asked explicitly for full access to the Claude CLI's functions from inside the
product.

## Decision

Two additive-optional `lanes.start` inputs (RPC-schema only; no protocol-package event,
mandate, or store change):

- **`workspace: 'project' | 'isolated'`** — `'project'` resolves the project's bound
  working folder (`projects.setRoot`) as the session cwd. The daemon resolves it (the
  UI never sees filesystem paths), **before** the ADR-0053 idempotency lookup so the
  resolved folder is part of the operation's identity. No bound folder → an honest
  `conflict` telling the operator to bind one. Ignored when explicit `scope.paths` are
  given; absent/`'isolated'` keeps the ADR-0039 per-lane jail.
- **`sendGoal: false`** — console mode. The goal becomes a **label** (list/capsule
  display); nothing is auto-typed into the pane. The kernel settles goal delivery on
  the durable event log at start (`lane.progress` `SESSION_GOAL_SENT_PROGRESS`, plus an
  honest "operator console" note first), so every later path — resume after a daemon
  restart, snapshot, session send — reads delivery as settled and never types the label
  into the operator's console. No lanes-package or tmux-marker change was needed.

The web Session Workspace makes the goal optional: an empty goal opens a clean console
("Open console"), and a Folder select chooses project-folder vs isolated (default:
project folder).

## Security posture (unchanged mechanisms, one widened default-by-choice)

- The project folder is **already inside `laneAllowedRoots`** — `projects.setRoot`
  refuses anything outside it, and the tmux runner still refuses a cwd outside every
  allowed root (`isWithinRoots`).
- The Approval Constitution still gates every open: an interactive `*-tmux` session is
  a MATERIAL class, and a project-folder cwd is additionally `writes-shared-root`. One
  operator approval per open, deny-by-default, exactly as before.
- The session runs the agent CLI **bare** (no `--dangerously-skip-permissions`); the
  CLI's own permission prompts remain, answered by the operator in the ADR-0052
  terminal. This is the ADR-0049 attended-session model — the widened surface (real
  project files instead of an empty jail) is an explicit operator choice behind the
  same gate.
- The env scrub (deny-by-default allowlist) is unchanged: `HOME` survives, so the CLI's
  own auth/config/skills/MCP-OAuth work; daemon secrets still never enter a session.

## Consequences

- The operator gets a real Claude/Codex CLI on real project files inside Amrita —
  models, skills, MCP, /commands, permission prompts — with one approval per open.
- A console lane still ends like any lane (finish/cancel → MergeReport `operator
  finished the session` path), so Watcher/capsule/task supervision see it.
- The `SESSION_GOAL_SENT_PROGRESS` audit note on a console lane means "goal delivery is
  settled (suppressed)" — the preceding "operator console" note records why. Documented
  here to keep the audit honest.
