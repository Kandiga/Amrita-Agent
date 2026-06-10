import { z } from 'zod';
import { idSchema, isoTimestampSchema, ulidSchema } from './ids.ts';
import { laneMandateSchema, mergeReportSchema, usageSchema } from './lane.ts';

/**
 * The event protocol — Amrita's constitution.
 *
 * Everything that happens in a conversation is an append-only event with a
 * shared envelope and a per-type payload. Events are totally ordered within a
 * conversation by a monotonic `seq` (assigned by the store inside the append
 * transaction). The envelope is identical across every channel, the daemon, the
 * store, and every lane — nothing crosses a boundary unparsed.
 *
 * Adding or changing an event type requires an ADR (see CLAUDE.md).
 */

export const eventOriginSchema = z.enum(['user', 'agent', 'lane', 'system']);
export type EventOrigin = z.infer<typeof eventOriginSchema>;

export const eventChannelSchema = z.enum(['web', 'telegram', 'cli', 'api']);
export type EventChannel = z.infer<typeof eventChannelSchema>;

/** The sealed envelope — carries `seq`, assigned by the store on append. */
export const eventEnvelopeBaseSchema = z
  .object({
    id: ulidSchema,
    seq: z.number().int().nonnegative(),
    ts: isoTimestampSchema,
    projectId: idSchema,
    conversationId: idSchema,
    turnId: idSchema.optional(),
    laneId: idSchema.optional(),
    origin: eventOriginSchema,
    channel: eventChannelSchema.optional(),
  })
  .strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeBaseSchema>;

// ---------------------------------------------------------------------------
// Payloads, by namespace. Keep each payload `.strict()` so unknown keys throw.
// ---------------------------------------------------------------------------

const empty = z.object({}).strict();

const attachmentSchema = z
  .object({
    artifactId: idSchema.optional(),
    name: z.string(),
    mime: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const toolResultSchema = z
  .object({
    // Inline result, OR a pointer to a spilled artifact when the payload is large.
    result: z.unknown().optional(),
    spilledArtifactId: idSchema.optional(),
    preview: z.string().optional(),
    isError: z.boolean().default(false),
  })
  .strict();

// Entity sub-schemas (mirror the store enums added in WO#1.1 / ADR-0003).
const taskStatusSchema = z.enum(['now', 'later', 'done', 'dropped']);
const memoryScopeSchema = z.enum(['user', 'project']);
const connectorStatusSchema = z.enum(['needs_setup', 'ready', 'error', 'disabled']);
const authModeSchema = z.enum(['api_key', 'subscription_cli', 'local_endpoint', 'oauth']);
/** Keys that must never appear in `settings` (mirrors the store CHECK, ADR-0003). */
const SECRET_KEY_RE = /secret|api[_-]?key|apikey|token|password/i;

/**
 * The canonical map: event type -> payload schema. The keys are the closed set
 * of legal event types. This object IS the protocol surface.
 */
export const eventPayloads = {
  // conversation lifecycle
  'conversation.created': z.object({ title: z.string().optional() }).strict(),
  'conversation.renamed': z.object({ title: z.string() }).strict(),
  'conversation.archived': empty,

  // messages
  'message.user': z
    .object({ text: z.string(), attachments: z.array(attachmentSchema).optional() })
    .strict(),
  'message.agent': z.object({ text: z.string() }).strict(),
  'message.system': z.object({ text: z.string() }).strict(),

  // turns
  'turn.started': z.object({ trigger: z.enum(['user', 'schedule', 'channel', 'lane']) }).strict(),
  'turn.completed': z.object({ usage: usageSchema.optional() }).strict(),
  'turn.interrupted': z.object({ reason: z.string().optional() }).strict(),
  'turn.failed': z.object({ error: z.string() }).strict(),

  // model calls
  'model.request': z
    .object({
      provider: z.string(),
      model: z.string(),
      role: z.enum(['fast', 'main', 'deep']),
    })
    .strict(),
  // STREAM ONLY — never persisted (see STREAM_ONLY_TYPES).
  'model.delta': z.object({ text: z.string() }).strict(),
  'model.response': z.object({ text: z.string(), finishReason: z.string().optional() }).strict(),
  'model.usage': usageSchema,

  // tools
  'tool.requested': z
    .object({ toolCallId: z.string(), name: z.string(), input: z.unknown() })
    .strict(),
  'tool.approved': z.object({ toolCallId: z.string() }).strict(),
  'tool.denied': z.object({ toolCallId: z.string(), reason: z.string().optional() }).strict(),
  'tool.started': z.object({ toolCallId: z.string(), name: z.string() }).strict(),
  'tool.output': z.object({ toolCallId: z.string(), chunk: z.string() }).strict(),
  'tool.completed': z.object({ toolCallId: z.string(), result: toolResultSchema }).strict(),
  'tool.failed': z.object({ toolCallId: z.string(), error: z.string() }).strict(),

  // lanes
  'lane.spawned': z.object({ laneId: idSchema, kind: z.string() }).strict(),
  'lane.mandate': laneMandateSchema,
  'lane.progress': z
    .object({ note: z.string(), pct: z.number().min(0).max(100).optional() })
    .strict(),
  'lane.merge_report': mergeReportSchema,
  'lane.completed': z.object({ laneId: idSchema, exit: z.string() }).strict(),
  'lane.aborted': z.object({ laneId: idSchema, reason: z.string() }).strict(),

  // approvals
  'approval.requested': z
    .object({ approvalId: idSchema, action: z.string(), detail: z.string().optional() })
    .strict(),
  'approval.resolved': z
    .object({ approvalId: idSchema, decision: z.enum(['allow', 'deny']) })
    .strict(),

  // memory & artifacts
  // memory.written is the markdown-vault file-export signal (path-based), kept
  // distinct from the row-level memory_entries events below. See ADR-0004.
  'memory.written': z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).strict(),
  // RECONCILED in WO#1.2: a row-level upsert of a memory_entries row (create or
  // update), carrying entry provenance for projection. (Was path-based.)
  'memory.updated': z
    .object({
      entryId: idSchema,
      scope: memoryScopeSchema,
      projectId: idSchema.optional(),
      charCount: z.number().int().nonnegative().optional(),
      source: z.string().optional(),
      sourceMessageId: idSchema.optional(),
    })
    .strict(),
  'memory.consolidated': z
    .object({
      resultEntryId: idSchema,
      sourceEntryIds: z.array(idSchema).min(1),
      scope: memoryScopeSchema,
      projectId: idSchema.optional(),
    })
    .strict(),
  'artifact.created': z
    .object({ artifactId: idSchema, kind: z.string(), bytes: z.number().int().nonnegative() })
    .strict(),

  // projects
  'project.created': z.object({ slug: z.string(), name: z.string() }).strict(),
  'project.updated': z.object({ fields: z.array(z.string()) }).strict(),

  // channels
  'channel.connected': z.object({ channel: eventChannelSchema }).strict(),
  'channel.message_in': z.object({ channel: eventChannelSchema, externalId: z.string() }).strict(),
  'channel.message_out': z.object({ channel: eventChannelSchema }).strict(),

  // tasks
  'task.created': z
    .object({
      taskId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      laneId: idSchema.optional(),
      title: z.string().min(1),
      status: taskStatusSchema.optional(),
    })
    .strict(),
  'task.updated': z
    .object({
      taskId: idSchema,
      status: taskStatusSchema.optional(),
      title: z.string().min(1).optional(),
      body: z.string().optional(),
    })
    .strict(),
  'task.completed': z.object({ taskId: idSchema }).strict(),

  // decisions (append-only log)
  'decision.recorded': z
    .object({
      decisionId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      text: z.string().min(1),
    })
    .strict(),
  'decision.superseded': z
    .object({
      decisionId: idSchema,
      supersedesId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      text: z.string().min(1),
    })
    .strict(),

  // providers (account + runtime health transitions)
  'provider.connected': z
    .object({ provider: z.string(), accountId: idSchema.optional(), authMode: authModeSchema })
    .strict(),
  'provider.degraded': z
    .object({ provider: z.string(), accountId: idSchema.optional(), reason: z.string() })
    .strict(),
  'provider.restored': z.object({ provider: z.string(), accountId: idSchema.optional() }).strict(),

  // connectors
  'connector.installed': z
    .object({ connectorId: idSchema, slug: z.string(), kind: z.string() })
    .strict(),
  'connector.updated': z
    .object({
      connectorId: idSchema,
      slug: z.string(),
      status: connectorStatusSchema.optional(),
      fields: z.array(z.string()).optional(),
    })
    .strict(),
  'connector.removed': z.object({ connectorId: idSchema, slug: z.string() }).strict(),

  // settings (non-secret config; secret-ish keys rejected, mirroring the store)
  'settings.updated': z
    .object({ key: z.string().min(1), value: z.unknown() })
    .strict()
    .refine((p) => !SECRET_KEY_RE.test(p.key), {
      message: 'settings keys must not look like secrets (use accounts.secret_ref)',
    }),

  // diagnostics
  'error.raised': z.object({ message: z.string(), code: z.string().optional() }).strict(),
  'audit.logged': z.object({ action: z.string(), target: z.string().optional() }).strict(),
} as const;

export type EventPayloads = typeof eventPayloads;
export type EventType = keyof EventPayloads;

/** Event types that may be emitted on the live stream but MUST NOT be persisted. */
export const STREAM_ONLY_TYPES: ReadonlySet<EventType> = new Set<EventType>(['model.delta']);

export const eventTypeSchema = z.enum(Object.keys(eventPayloads) as [EventType, ...EventType[]]);

/** A fully-typed, sealed event for a given type `T`. */
export type AmritaEvent<T extends EventType = EventType> = {
  [K in T]: EventEnvelope & { type: K; payload: z.infer<EventPayloads[K]> };
}[T];

/** An event a producer emits before the store assigns `seq`. */
export type UnsealedEvent<T extends EventType = EventType> = Omit<AmritaEvent<T>, 'seq'>;

// ---------------------------------------------------------------------------
// Parsers. Base-parse the envelope, then dispatch the payload by `type`.
// ---------------------------------------------------------------------------

const sealedShellSchema = eventEnvelopeBaseSchema.extend({
  type: eventTypeSchema,
  payload: z.unknown(),
});

const unsealedShellSchema = eventEnvelopeBaseSchema
  .omit({ seq: true })
  .extend({ type: eventTypeSchema, payload: z.unknown() });

function parsePayload<T extends EventType>(type: T, payload: unknown): z.infer<EventPayloads[T]> {
  const schema = eventPayloads[type];
  return schema.parse(payload) as z.infer<EventPayloads[T]>;
}

/** Parse a sealed event (envelope incl. `seq` + dispatched payload). Throws on mismatch. */
export function parseEvent(input: unknown): AmritaEvent {
  const shell = sealedShellSchema.parse(input);
  const payload = parsePayload(shell.type, shell.payload);
  return { ...shell, payload } as AmritaEvent;
}

/** Parse an unsealed event (no `seq` yet). Throws on mismatch. */
export function parseUnsealedEvent(input: unknown): UnsealedEvent {
  const shell = unsealedShellSchema.parse(input);
  const payload = parsePayload(shell.type, shell.payload);
  return { ...shell, payload } as UnsealedEvent;
}

/** Type guard: is this a stream-only event type that must not be persisted? */
export function isStreamOnly(type: EventType): boolean {
  return STREAM_ONLY_TYPES.has(type);
}
