# Spec: the amritad runtime (kernel + JSON-RPC)

`@amrita/daemon` is Amrita's runtime shell. This is the prose companion to the code; the code is
authoritative. See [ADR-0009](../adr/0009-amritad-kernel-and-rpc.md). **No provider calls, tool
execution, or lanes run here yet** — this is the control boundary only.

## Layout

```
packages/daemon/src/
  kernel.ts   AmritaKernel — owns the Store; lifecycle + Store-API delegation
  rpc.ts      method registry, zod validation, dispatch, error shape
  stdio.ts    JSON-lines stdio server (any Readable/Writable)
  util.ts     clean() — strips undefined for exact-optional interop
  bin/amritad.ts   executable entrypoint
```

## Kernel

`AmritaKernel.open({ dbPath, spillDir? })` opens the store (WAL, FK on, migrations applied) and starts
the kernel; `close()` closes it. `health()` → `{ ok, name:'amritad', startedAt, dbPath, schemaVersion,
counts:{projects,conversations,messages,events} }`. All other methods delegate to the Store API
(tasks/decisions/memory/settings/accounts/connectors/lanes, plus `ensureProject`, conversations,
`recordUserMessage`, `listEvents`). The kernel writes no SQL except two read-only diagnostics. It is
deterministic and free of provider/tool/lane execution.

## JSON-RPC

- **Request:** `{ id?: string|number|null, method: string, params?: object }`. Unknown envelope keys
  (e.g. `jsonrpc`) are stripped.
- **Success:** `{ id, result }`.
- **Error:** `{ id, error: { code, message, details? } }`, `code ∈ {invalid_request, unknown_method,
  invalid_params, not_found, conflict, internal}`. `details` (for validation errors) is a list of
  `{path, message, code}` — never echoed values, never a stack trace.

### Methods (stable)

| Method | Params | Result |
|--------|--------|--------|
| `ping` | — | `{ pong: true }` |
| `health` | — | kernel health |
| `doctor` | — | grouped setup/health checks (`{ok, status, sections[], fixes[]}`, PLAN §5.4; warn = needs setup, fail = explicitly configured but unusable; presence-only env checks, never a value) |
| `project.ensure` | `{slug, name, root?}` | project row (create-or-get) |
| `project.get` | `{id?, slug?}` | project row or `null` |
| `project.list` | — | project rows |
| `conversation.create` | `{projectId, title?, parentId?}` | conversation row |
| `conversation.tree` | `{conversationId}` | subtree via `parent_id` |
| `conversation.get` | `{conversationId}` | conversation node or `null` |
| `conversation.list` | `{projectId}` | conversations in a project |
| `message.user.record` | `{projectId, conversationId, text, channel?}` | `{messageId, event}` |
| `events.list` | `{conversationId, sinceSeq?}` | events |
| `tasks.create` | `{projectId, conversationId, title, status?, origin?}` | `{taskId}` |
| `tasks.list` | `{projectId?, conversationId?, status?}` | task rows |
| `tasks.complete` | `{projectId, conversationId, taskId, origin?}` | `{ok}` |
| `decisions.record` | `{projectId, conversationId, text, origin?}` | `{decisionId}` |
| `decisions.list` | `{projectId?, conversationId?, includeSuperseded?}` | decision rows |
| `memory.put` | `{projectId, conversationId, scope, content, entryId?, source?}` | `{entryId}` |
| `memory.search` | `{query, scope?, projectId?, limit?}` | memory rows (FTS, bm25-ranked) |
| `settings.update` | `{projectId, conversationId, key, value, origin?}` | `{ok}` |
| `settings.get` | `{key}` | `{value}` (or `{value:null}`) |
| `accounts.connect` | `{projectId, conversationId, provider, authMode, label?, origin?}` | `{accountId}` |
| `accounts.list` | — | account rows (`secretRef` is an env-NAME) |
| `accounts.bindSecretRef` | `{accountId, envName}` | `{ok}` |
| `accounts.configStatus` | `{accountId}` | `{status}` |
| `connectors.list` | — | connector rows |
| `lanes.list` | `{projectId?, conversationId?, status?}` | lane rows |
| `lanes.start` | `{conversationId, goal, kind?, dryRun?, real?, detach?, scope?, budget?, contextPack?, approvals?, deliverables?}` | `{laneId, status, dryRun, detached, report?, error?}` |
| `lanes.get` | `{laneId}` | lane row or `null` |
| `lanes.cancel` | `{laneId}` | `{laneId, cancelled, status}` |
| `approvals.list` | — | pending operator approvals (ADR-0021; runtime state, events are the audit) |
| `approvals.resolve` | `{approvalId, decision: allow\|deny}` | `{approvalId, resolved}` — unknown/settled ids report `resolved:false` |
| `projects.companion.get` | `{projectId}` | `{brief|null, brand|null, questions[], risks[], milestones[], previewApprovals[]}` — the Project Brain aggregate (ADR-0018/0020) |
| `projects.brief.update` | `{projectId, conversationId, goal, audience?, successCriteria?, scope?, noScope?, sourceMessageId?}` | `{ok}` (full-document upsert) |
| `projects.questions.open` | `{projectId, conversationId, text, sourceMessageId?}` | `{questionId}` |
| `projects.questions.resolve` | `{…, questionId, resolution? \| resolvedByDecisionId?}` (≥1 required) | `{ok}` |
| `projects.questions.drop` | `{…, questionId, reason}` | `{ok}` |
| `projects.risks.open/resolve/drop` | mirror questions (+ optional `severity` on open) | `{riskId}` / `{ok}` |
| `projects.milestones.create` | `{…, title, description?, targetDate?, status?}` | `{milestoneId}` |
| `projects.milestones.update` | `{…, milestoneId, title?, description?, status?, targetDate?}` | `{ok}` |
| `projects.milestones.complete` | `{…, milestoneId}` | `{ok}` |
| `projects.timeline.list` | `{projectId, limit?}` | events, newest first — derived from the log |
| `projects.brand.update` | `{projectId, conversationId, name?, audience?, tone?, styleNotes?, palette?, typography?, doNotUse?}` | `{ok}` — full-document brand upsert (ADR-0020; ≥1 substantive field) |
| `projects.previews.approve` | `{projectId, conversationId, previewId, contentHash}` | `{ok}` — durable approval; state drift demotes the preview back to proposed |
| `chat.turn` | `{conversationId, text, provider?, model?, role?, accountId?, dryRun?, channel?}` | turn result (secret-free; includes the resolved `role`) |
| `providers.list` | — | provider availability incl. honest `streaming` capability (no secret values) |
| `providers.roles` | `{projectId?}` | per-role `{binding, projectBinding, resolvesTo, model?, via: project\|binding\|auto}` (ADR-0017/0019) |
| `runtime.status` | `{projectId?}` | the Settings-Hub aggregate: `{roles, providers, codingRuntimes}` — coding runtimes probed with bounded no-shell commands, classified honestly (ADR-0019 §6), never green on an inconclusive probe |
| `providers.role.set` | `{role, provider, model?, projectId?}` | `{ok}` — THE validated role-binding write path (provider checked against the catalog, project must exist) |
| `providers.role.clear` | `{role, projectId?}` | `{ok}` — resolution falls back (project→global→auto) |

A **chat turn** records the user message, `await`s the provider boundary (default `mock`), and
persists the assistant message + `turn.*`/`model.*` events (ADR-0011/0012). The assistant message is a
`message.agent` (searchable). **`dispatch` is async** — handlers may return a Promise; the stdio
server serializes requests so responses stay in order.

**Providers (ADR-0012):** `mock` (deterministic, default) plus real `anthropic`/`openai` adapters
(native `fetch`, injectable for tests). A real provider needs an account with a bound `secret_ref`
whose env var is present; the secret **value** is read only at adapter construction and never enters
events/RPC/CLI/logs. Selection: `provider=anthropic|openai` uses the given `accountId` or the first
configured account for that provider, else a safe `not_found`. Errors are structured and value-free:
`missing_secret_ref` · `missing_env_value` · `not_found` · `provider_unavailable` · `provider_error`.
`providers.list` reports `available`/`configuredAccounts`/`envReady`/`streaming` (booleans only —
`streaming` is true only for providers that actually implement `generateStream`, ADR-0016; never
faked for the real adapters until SSE lands).

**Role policy (ADR-0017 + §2.8 of the native-surface strategy):** `chat.turn {role:
fast|main|deep}` resolves **project binding > global binding > auto** — the project binding is
`project.<projectId>.providers.role.<role>` in settings (the turn's project comes from its
conversation), the global one is `providers.role.<role>`, and `auto` is the first *available*
real provider, else mock. An explicit `provider` always wins. `providers.roles {projectId?}`
reports both scopes plus the effective resolution (`via: project|binding|auto`). The resolved
role **and its scope provenance** are persisted on `model.request` (`via:
explicit|project|binding|auto|default`, ADR-0019) and returned on the result — so switching
the brain never rewrites history: each turn keeps the provider/model/scope it actually ran
under, and project memory/conversations are provider-independent by construction (enforced by
`test/invariance.test.ts`). Lane/task and session scopes are additive keys on the same
resolver (future).

Global-config writes (`settings`/`accounts`) still carry a `conversationId` (the originating/system
conversation) because every event has an envelope (ADR-0007). Entity writes default `origin` to
`system`.

## HTTP + WebSocket (WO#2.5)

`startHttpServer(kernel, {port?, host?})` (or `amritad --http --port N`) exposes a localhost HTTP/WS
surface over the same async dispatch. Default host `127.0.0.1`. No framework — three routes + one WS
endpoint. No response or frame carries a secret value.

| Route | Behaviour |
|---|---|
| `GET /health` | kernel health JSON |
| `POST /rpc` | body is a JSON-RPC request; response is the `RpcResponse` (HTTP 200 even for RPC errors; HTTP 400 only for non-JSON / oversized body) |
| `GET /events?conversationId=&sinceSeq=` | `{conversationId, events}` — persisted events with `seq > sinceSeq`; 400 if `conversationId` missing |
| `WS /events/ws?conversationId=&sinceSeq=` | on connect, replays events after `sinceSeq` then a `{t:'replayed'}` frame; afterwards **live-streams** newly appended events for that conversation as `{t:'event', event}` frames |

Live fan-out is driven by `store.subscribe(listener)` — a **post-commit** notification of each sealed
event (a bad subscriber can never break a write). A WS connection without `conversationId` is closed
with code 1008. Request bodies are capped at 1 MB.

**Stream-only deltas (WO#5.3, ADR-0016):** the kernel has a second, ephemeral fan-out —
`subscribeStream(listener)` — for `model.delta`. A chat turn whose provider implements
`generateStream` (the mock does; real adapters don't yet) emits deltas sealed with `seq: 0`,
protocol-parsed, to live WS connections only. They are never persisted, never replayed by
`GET /events`, and never advance the client's `sinceSeq` cursor; the persisted log is identical to
a non-streaming turn.

### Auth guard (WO#4.3)

The HTTP/WS surface is protected by a single local **bearer token** (`packages/daemon/src/auth.ts`,
ADR-0014). This token is *local session config*, **not** a provider secret: it is read from
`AMRITA_AUTH_TOKEN`, or — when unset — generated ephemerally at startup and printed **once** to stdout
(never to a file, an event, the DB, or a log).

- **`GET /health` is always public.** Every other route requires `Authorization: Bearer <token>`.
- The gate runs **before route matching**, so an unauthenticated caller cannot probe which routes
  exist; a failure is `401 { error: { code: "unauthorized" } }` with no echoed token.
- **WebSocket:** browsers cannot set headers on the `WebSocket` handshake, so `WS /events/ws` also
  accepts the token as a **`?token=`** query parameter (an `Authorization` header is honoured too, for
  non-browser clients). A bad handshake is answered `401` and the socket destroyed.
- Comparison is constant-time (`timingSafeEqual`) and never throws on a length mismatch.
- `startHttpServer(kernel, { authToken })` enables the guard; an empty/omitted `authToken` leaves the
  surface open (used by in-process tests). The `amritad --http` bin always enables it (env or
  generated).

The `amrita` CLI speaks RPC **in process** (no HTTP), so it needs no token. An HTTP client (the web UI)
must send the bearer token on `/rpc` and `/events`, and the `?token=` query on the WS.

### Lane execution (WO#5.2)

Lanes run delegated work (e.g. Claude Code) beside a conversation. See [lanes.md](lanes.md) and
[ADR-0015](../adr/0015-real-lane-execution-opt-in.md).

- **Real execution is opt-in and off by default.** Enable it with `AMRITA_LANES_ALLOW_REAL_EXECUTION=1`
  or `AmritaKernel.open({ allowRealLaneExecution })`. `health.lanes.realExecution` reports the posture
  (boolean), and `amritad --http` prints it once at startup (to stderr on stdio). Without opt-in, every
  non-dry lane ends safely as `aborted`; a `lanes.start { real: true }` on a non-opted-in daemon fails
  safely **without running**.
- **Workspace confinement.** Real lanes are confined to `AMRITA_LANES_ALLOWED_ROOTS` (`:`-separated) or
  `laneAllowedRoots`; if real exec is on and none are configured, lanes are confined to the daemon cwd.
- **`detach`** returns immediately (`status: 'running'`) and runs the lane in the background — the web
  observes it over the live event stream; `lanes.cancel` aborts it (terminating the child) and the lane
  reports `exit: 'cancelled'`. Without `detach`, `lanes.start` awaits completion (CLI/synchronous use).
- The daemon never forwards a secret into a lane, and aborts all active lanes on shutdown.
- **Operator approvals (ADR-0021):** a `real: true` start under the default `forward` policy
  pauses on a `lane.run-real` approval — resolved via `approvals.resolve` (web/Telegram),
  timed out to DENY (default 120 s), or denied by cancellation; the runner never executes
  without an explicit allow. `auto-safe`/`sandboxed` pre-authorize and skip the gate.
- **Telegram operator runner:** `amritad --http --telegram` long-polls the official Bot API
  (owner allowlist from `AMRITA_TELEGRAM_ALLOWED_IDS`, token from `TELEGRAM_BOT_TOKEN`,
  presence-checked, never logged). Refuses to start unconfigured. `channels.list`/doctor say
  telegram is `ready` only while the runner is live.

## Transport & CLI

JSON-lines over stdio: one request object per input line, one response per output line. The `amritad`
bin:

```bash
pnpm amritad -- --db ~/.amrita/amrita.db      # or --db=:memory:
echo '{"id":1,"method":"ping"}' | pnpm amritad -- --db :memory:
```

It serves until stdin closes, then closes the kernel and exits. Tests drive the same server in-process
with `PassThrough` streams (deterministic, no subprocess); one test also spawns the executable to prove
it runs end-to-end.

The `amrita` CLI (`@amrita/cli`, [cli.md](cli.md)) is a higher-level client that dispatches the same
RPC **in process** against a `--db`, with human/`--json` output — the ergonomic way to operate Amrita
locally.

## Security

No response carries a secret value. `accounts.*` expose only env-NAME `secretRef` + health/status;
secret binding is the Store's secure direct-write path (ADR-0008), not an RPC value. Errors never
include a stack trace or echoed input. The daemon writes only responses to stdout — it does not log
request params.
