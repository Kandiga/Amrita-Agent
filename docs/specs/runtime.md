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
| `project.ensure` | `{slug, name, root?}` | project row (create-or-get) |
| `project.get` | `{id?, slug?}` | project row or `null` |
| `project.list` | — | project rows |
| `conversation.create` | `{projectId, title?, parentId?}` | conversation row |
| `conversation.tree` | `{conversationId}` | subtree via `parent_id` |
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
| `accounts.connect` | `{projectId, conversationId, provider, authMode, origin?}` | `{accountId}` |
| `accounts.list` | — | account rows (`secretRef` is an env-NAME) |
| `accounts.bindSecretRef` | `{accountId, envName}` | `{ok}` |
| `accounts.configStatus` | `{accountId}` | `{status}` |
| `connectors.list` | — | connector rows |
| `lanes.list` | `{projectId?, conversationId?, status?}` | lane rows |

Global-config writes (`settings`/`accounts`) still carry a `conversationId` (the originating/system
conversation) because every event has an envelope (ADR-0007). Entity writes default `origin` to
`system`.

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

## Security

No response carries a secret value. `accounts.*` expose only env-NAME `secretRef` + health/status;
secret binding is the Store's secure direct-write path (ADR-0008), not an RPC value. Errors never
include a stack trace or echoed input. The daemon writes only responses to stdout — it does not log
request params.
