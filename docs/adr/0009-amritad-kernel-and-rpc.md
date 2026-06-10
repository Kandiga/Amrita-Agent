# ADR-0009: amritad kernel + local JSON-RPC daemon

- **Status:** Accepted
- **Date:** 2026-06-10
- **Context:** Phase-1 (protocol, store, projections, typed Store API, secure refs) is complete. WO#2.1
  starts the runtime shell: a kernel + local control RPC, with **no** provider calls, tool execution,
  or lanes yet. This fixes the daemon boundary before any of those land.

## Decision

### Package layout
A single `@amrita/daemon` package holds the kernel (`kernel.ts`), the RPC layer (`rpc.ts`), the stdio
transport (`stdio.ts`), and the `amritad` bin. The kernel is kept as a distinct module so it can be
extracted to a `@amrita/core` package later without a rewrite; co-locating now avoids premature
package boilerplate.

### Kernel boundary
`AmritaKernel` owns the `Store` and exposes lifecycle (`open`/`close`/`health`) plus thin delegation
to the Store API. **The kernel uses the Store API, never raw SQL** — the only exceptions are two
read-only diagnostics (`MAX(version)` for the schema version, and `store.stats()` counts), both
secret-free. The kernel is deterministic and **does not** call model providers, run tools, or execute
lanes (those are later WOs); it is an application-services layer over the event-sourced store.

### JSON-RPC contract
A small JSON-RPC-ish layer. **Request:** `{ id?, method, params? }` (unknown envelope keys such as a
client's `jsonrpc` are stripped). **Success:** `{ id, result }`. **Error:** `{ id, error: { code,
message, details? } }`. `code` is a string enum: `invalid_request | unknown_method | invalid_params |
not_found | conflict | internal`. Requests and params are validated with zod; an invalid request or
param yields a structured error with `details` = projected zod issues (`{path, message, code}` only —
**never** echoed received values). Method names are stable and documented in `runtime.md`.

Method namespaces: `ping`, `health`, `project.*`, `conversation.*`, `message.user.record`,
`events.list`, `tasks.*`, `decisions.*`, `memory.*`, `settings.*`, `accounts.*`, `connectors.list`,
`lanes.list`.

### Transport
A JSON-lines **stdio** server (one request per line, one response per line; blank lines ignored,
unparseable lines answered with `invalid_request` without crashing the loop). It accepts any
`Readable`/`Writable`, so tests drive it in-process (no fragile subprocess). The `amritad` bin wires
stdin/stdout and closes the kernel when stdin ends. Unix-socket/HTTP transports are deferred.

### Why provider/tool execution is out of scope
The daemon boundary (kernel API + RPC contract + transport) must be stable and tested before anything
calls a model or runs a tool — otherwise the contract churns under feature work. Provider runtime, the
turn loop, lanes, channels, and the web UI all build *on top of* this boundary in later WOs.

## Secret handling in responses & logs
- No response includes a secret value. `accounts.*` expose only `secretRef` (an env-var **NAME**) and
  derived health/status; secret binding goes through the Store's secure path (ADR-0008), never RPC
  params that carry a value.
- Errors carry a message + safe details, **never a stack trace** and never received input values.
- The daemon writes only RPC responses to stdout; it does not log request params.

## Lifecycle
`AmritaKernel.open({dbPath})` opens SQLite (WAL, FK on) and runs `migrateUp`. `health` reports
`{ok, name, startedAt, dbPath, schemaVersion, counts}`. `close()` closes the DB. The bin starts the
stdio server and calls `kernel.close()` on stdin end, then exits.

## Consequences
The next WO can build a CLI client (and later a socket/HTTP transport) against a frozen method list
and error shape. Adding a method is a new entry in the `METHODS` registry + a doc line; it must remain
secret-free and validated.
