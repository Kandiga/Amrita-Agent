import { z } from 'zod';
import { eventEnvelopeBaseSchema, eventTypeSchema } from './events.ts';
import { idSchema } from './ids.ts';

/**
 * The transport RPC between a channel client (web/CLI) and the daemon. Two
 * discriminated unions: what the client may send, and what the server may push.
 * Both are parsed at the socket boundary — an unparseable frame is dropped with
 * an `error` reply, never acted on.
 */

// ---- client -> server -----------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('subscribe'),
      conversationId: idSchema,
      sinceSeq: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      t: z.literal('message.send'),
      conversationId: idSchema,
      text: z.string().min(1),
      clientNonce: z.string().optional(),
    })
    .strict(),
  z.object({ t: z.literal('turn.interrupt'), conversationId: idSchema }).strict(),
  z
    .object({
      t: z.literal('approval.resolve'),
      approvalId: idSchema,
      decision: z.enum(['allow', 'deny']),
    })
    .strict(),
  z
    .object({
      t: z.literal('lane.action'),
      laneId: idSchema,
      action: z.enum(['pause', 'resume', 'abort']),
    })
    .strict(),
  z.object({ t: z.literal('typing'), conversationId: idSchema }).strict(),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---- server -> client -----------------------------------------------------

/** A pushed event frame. The payload is opaque here; `parseEvent` re-validates it. */
const serverEventFrameSchema = eventEnvelopeBaseSchema
  .extend({ type: eventTypeSchema, payload: z.unknown() })
  .strict();

export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('event'), event: serverEventFrameSchema }).strict(),
  z
    .object({ t: z.literal('ack'), conversationId: idSchema, seq: z.number().int().nonnegative() })
    .strict(),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }).strict(),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(input: unknown): ClientMessage {
  return clientMessageSchema.parse(input);
}

export function parseServerMessage(input: unknown): ServerMessage {
  return serverMessageSchema.parse(input);
}
