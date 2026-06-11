# Spec: the event protocol

`@amrita/protocol` is Amrita's constitution. This document is the prose companion to the code in
`packages/protocol/src/`; the code is authoritative. Changing either requires an ADR.

## The envelope (`eventEnvelopeBaseSchema`)

A *sealed* event — one that has been persisted — carries:

| field | type | notes |
|-------|------|-------|
| `id` | ULID | unique per event |
| `seq` | int ≥ 0 | **per-conversation** monotonic order, assigned by the store on append |
| `ts` | ISO-8601 | producer timestamp |
| `projectId` | ULID | |
| `conversationId` | ULID | |
| `turnId` | ULID? | present once a turn is underway |
| `laneId` | ULID? | present for lane-originated events |
| `origin` | `user \| agent \| lane \| system` | who caused it |
| `channel` | `web \| telegram \| cli \| api`? | where it entered, if a channel |

The envelope is `.strict()`: an unknown field throws. An *unsealed* event is the same minus `seq`
(what a producer emits before the store seals it).

## Event types (`eventPayloads`)

The `eventPayloads` map is the **closed set** of legal types — its keys are the type union
`EventType`, and each value is the payload schema. Namespaces:

- **conversation.** `created`, `renamed`, `archived`
- **message.** `user`, `agent`, `system`
- **turn.** `started`, `completed`, `interrupted`, `failed`
- **model.** `request`, `delta` *(stream-only)*, `response`, `usage`
- **tool.** `requested`, `approved`, `denied`, `started`, `output`, `completed`, `failed`
- **lane.** `spawned`, `mandate`, `progress`, `merge_report`, `completed`, `aborted`
- **approval.** `requested`, `resolved`
- **memory.** `written` *(vault file export)*, `updated` *(memory_entries upsert)*, `consolidated`
- **artifact.** `created`
- **project.** `created`, `updated`
- **channel.** `connected`, `message_in`, `message_out`
- **task.** `created`, `updated`, `completed`
- **decision.** `recorded`, `superseded`
- **provider.** `connected`, `degraded`, `restored`
- **connector.** `installed`, `updated`, `removed`
- **settings.** `updated`
- **error.** `raised`
- **audit.** `logged`

Every payload schema is `.strict()`. `tool.completed` carries a `toolResult` that is *either* an
inline `result` *or* a `{spilledArtifactId, preview}` pointer (the store rewrites it on spill — see
the store spec, D9).

### Entity events (WO#1.2, ADR-0004)

These produce the WO#1.1 entity rows; the WO#1.3 reducer projects them. All are **persisted** (none
stream-only) and carry provenance ids (ULIDs):

- **task.** `created {taskId, projectId, conversationId?, sourceMessageId?, laneId?, title, status?}`,
  `updated {taskId, status?, title?, body?}`, `completed {taskId}`.
- **decision.** `recorded {decisionId, projectId, conversationId?, sourceMessageId?, text}`,
  `superseded {…recorded fields, supersedesId}` — append a row that supersedes a prior decision.
- **memory.** `updated {entryId, scope, projectId?, charCount?, source?, sourceMessageId?}` (upsert a
  `memory_entries` row — *reconciled from the former path-based payload, ADR-0004*); `consolidated
  {resultEntryId, sourceEntryIds[], scope, projectId?}`. `written {path, bytes}` is unchanged and
  remains the markdown-vault file signal, **not** a `memory_entries` event.
- **provider.** `connected {provider, accountId?, authMode}`, `degraded {provider, accountId?,
  reason}`, `restored {provider, accountId?}`.
- **connector.** `installed {connectorId, slug, kind}`, `updated {connectorId, slug, status?,
  fields?}`, `removed {connectorId, slug}`.
- **settings.** `updated {key, value}` — `key` is rejected by a Zod `.refine` if it looks secret-ish
  (`secret`/`api_key`/`apikey`/`token`/`password`), mirroring the store CHECK. No secrets on the wire.

### Companion events (ADR-0018)

Project Companion Core entities (migration `0004_companion`). All persisted, all provenance-carrying:

- **brief.** `updated {projectId, goal, audience?, successCriteria[], scope[], noScope[],
  sourceMessageId?}` — a full-document upsert of the project brief (replay rebuilds the row).
- **question.** `opened {questionId, projectId, conversationId?, sourceMessageId?, text}`,
  `resolved {questionId, resolution?, resolvedByDecisionId?}` (a `.refine` requires at least one of
  the two — no silent wave-aways), `dropped {questionId, reason}`.
- **risk.** `opened {riskId, projectId, conversationId?, sourceMessageId?, text, severity?}`
  (`severity ∈ low|medium|high`, optional), `resolved`/`dropped` mirror `question.*`.
- **milestone.** `created {milestoneId, projectId, title, description?, targetDate?, status?}`
  (`status ∈ planned|active|done|dropped`, `targetDate` is `YYYY-MM-DD`),
  `updated {milestoneId, title?, description?, status?, targetDate?}`, `completed {milestoneId}`.
- **task.** `created`/`updated` additionally carry an optional `milestoneId` (nullable on `updated`
  to unlink a task).

There is no `timeline.*` event: the project timeline is a bounded read of the existing log by
`project_id` (ADR-0018).

## Stream-only types

`STREAM_ONLY_TYPES = { 'model.delta' }`. These may be pushed live to clients but the store rejects
them on `appendEvent`. The persistable record of a model turn is `model.response` (+ `model.usage`).
Rationale (D8): token deltas are high-volume and re-derivable; persisting them bloats the log and
makes replay noisy.

## Parsing

- `parseEvent(input)` — validates the sealed shell (envelope incl. `seq`), then dispatches the
  payload through `eventPayloads[type]`. Throws on any mismatch. Returns a discriminated
  `AmritaEvent` so `if (ev.type === 'message.user')` narrows `ev.payload`.
- `parseUnsealedEvent(input)` — same, without `seq`.
- `isStreamOnly(type)` — guard used by the store.

Round-trip invariant (Phase-0 acceptance): for any valid event `e`,
`parseEvent(JSON.parse(JSON.stringify(parseEvent(e))))` deep-equals `parseEvent(e)`.

## Lane contract (`lane.ts`)

- `LaneMandate` — `goal`, `contextPack {memory, files, decisions}`, `scope {paths?, repos?, network:
  none|allowlist|open}`, `budget {maxTurns?, maxTokens?, maxUsd?, maxMinutes?}`, `approvals:
  forward|auto-safe|sandboxed`, `deliverables`.
- `MergeReport` — `summary` (≤ 2000 chars), `artifacts`, `decisions`, `tasks`, `followUps`, `usage`,
  `exit: done|partial|aborted|budget`.

These two are the only vocabulary across the lane boundary (D7).

## RPC (`rpc.ts`)

- **client → server** (`ClientMessage`, discriminated on `t`): `subscribe`, `message.send`,
  `turn.interrupt`, `approval.resolve`, `lane.action`, `typing`.
- **server → client** (`ServerMessage`): `event` (an event frame), `ack` (conversationId + seq),
  `error` (code + message).

Both are parsed at the socket boundary; an unparseable frame yields an `error` reply and is never
acted upon.
