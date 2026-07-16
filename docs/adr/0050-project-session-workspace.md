# ADR-0050: Project-scoped interactive Session Workspace

- **Status:** Accepted
- **Date:** 2026-07-16
- **Amends:** ADR-0049
- **Owners:** Amrita core

## Context

ADR-0049 introduced durable interactive Claude/Codex sessions backed by tmux, but the first slice attached the live pane to the conversation that happened to create the lane. Changing chat tabs therefore hid a still-running session, and a browser refresh lost the stream-only pane until the next screen change. The runner also used a timeout that could eventually type the goal into an authentication screen.

The session is project work, not chat transcript content. At the same time, normal model token deltas are private to their conversation and must not become a project-wide stream.

## Decision

### 1. Existing lane rows remain the SSOT

Interactive sessions are the subset of project lanes whose `kind` ends in `-tmux`. `lanes.list({ projectId })` is the authoritative project listing. We do not add a second session table or duplicate lane state.

The tmux session name is deterministic and derived only at the execution boundary as `amrita-${lane.id}`. Agent identity is derived from the lane kind. The goal, scope, project, originating conversation, status, and timestamps remain in the existing lane projection.

This corrects the prospective schema text in ADR-0049: no `session_name`, `agent`, or `last_pane` columns are required. Raw pane content is never persisted.

### 2. Authentication is a human-owned blocking state

A detected login/account-selection screen is `awaiting-auth`. The runner may emit a redacted pane and status, but it must send **no keys and no goal text**. There is no timeout bypass. After the operator authenticates outside the product, normal readiness detection may continue.

Folder-trust/theme dialogs may accept only a narrowly allowlisted highlighted default with a literal Enter. Unknown startup output, spinners, login/account screens, updaters, and other interactive choices receive no input. Goal text is sent only after an explicit Claude/Codex ready prompt; Codex is launched with its interactive startup update check disabled.

### 3. Project-scoped stream uses an explicit allowlist

The WebSocket protocol adds `project-session-event`. The daemon may emit that frame across conversations only when all are true:

1. the socket explicitly subscribed with `projectId`;
2. event and socket project IDs match;
3. the event type is exactly stream-only `lane.pane`.

`model.delta` and every other conversation stream event remain conversation-local. The browser repeats the `lane.pane` allowlist as defense in depth. Project session frames never advance the per-conversation replay cursor.

### 4. Refresh uses an on-demand redacted snapshot

`lanes.session.snapshot({ projectId, laneId })` is a read-only RPC. It verifies that the lane belongs to the requested project and is interactive, derives the tmux session name, checks whether it exists, captures the pane only on demand, runs the same secret redactor as live capture, classifies lifecycle state, and returns a bounded snapshot.

The response is never persisted and never appended to the event log. A missing tmux session is reported honestly rather than synthesized as running.

### 5. Lifecycle state is execution truth, not a second domain state machine

The Session Workspace renders a derived lifecycle state:

- `awaiting-approval`
- `starting`
- `awaiting-auth`
- `running`
- `finishing`
- `completed`
- `aborted`
- `unavailable`

Persisted lane/approval projections provide durable states. Live pane classification and snapshot probing refine only the interactive runtime state. Browser reducers replace full pane snapshots per lane; they never append terminal text.

### 6. Project Workspace behavior

The web app loads interactive lanes with `lanes.list({ projectId })`, preserves the selected lane while navigating within that project, hydrates every active interactive lane via snapshot on load/reconnect, and consumes both conversation-local `lane.pane` and project `project-session-event` frames.

Controls remain explicit:

- **Send**, **Finish**, and **Cancel** all require both `projectId` and `laneId`; the daemon re-checks ownership before touching tmux.
- **Send** sends literal text only after the initial goal is durably marked sent and only when the current pane is not an auth/startup/blocked choice.
- **Finish** captures the final pane, resolves the lane gracefully, and tears down the tmux session.
- **Cancel** aborts the lane and kills the tmux session.
- No UI control automates login or forwards credentials.

## Consequences

- A running session remains visible across chat tabs and after refresh/reconnect.
- No raw terminal transcript or secret-shaped text is added to SQLite.
- `model.delta` remains isolated to its originating conversation.
- Deterministic tmux naming avoids a migration and duplicate identity fields.
- Snapshot capture is a runtime dependency and can honestly return unavailable if tmux disappeared.

## Verification

Required regression coverage:

1. persistent or late-arriving login/unknown/blocked startup panes receive no goal or manual input;
2. same-project/different-conversation sockets receive only allowlisted `lane.pane` session frames;
3. those sockets never receive another conversation's `model.delta`, and mixed project/conversation subscriptions are rejected;
4. snapshot and all controls are project-owned; captures are redacted, bounded, read-only, and refuse non-interactive lanes;
5. web reconnect hydrates project sessions without changing the chat cursor or accepting stale project/conversation responses;
6. daemon restart reattaches a surviving tmux lane, does not re-send a durably delivered goal, and sends an auth-blocked unsent goal once readiness appears.
