import { z } from 'zod';
import { idSchema, isoTimestampSchema } from './ids.ts';

/**
 * Row schemas for the persisted domain entities. These mirror the store tables
 * (see packages/store) and are the parsed shape returned across the daemon API.
 * The append-only event log is the source of truth; these are materialized
 * read-model rows.
 */

export const projectRowSchema = z
  .object({
    id: idSchema,
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be kebab-case'),
    name: z.string().min(1).max(200),
    root: z.string().nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ProjectRow = z.infer<typeof projectRowSchema>;

export const conversationRowSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    title: z.string().nullable(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    archivedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type ConversationRow = z.infer<typeof conversationRowSchema>;

export const messageRoleSchema = z.enum(['user', 'agent', 'system']);

export const messageRowSchema = z
  .object({
    id: idSchema,
    conversationId: idSchema,
    turnId: idSchema.nullable(),
    role: messageRoleSchema,
    text: z.string(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type MessageRow = z.infer<typeof messageRowSchema>;

export const artifactRowSchema = z
  .object({
    id: idSchema,
    conversationId: idSchema.nullable(),
    kind: z.string().min(1),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type ArtifactRow = z.infer<typeof artifactRowSchema>;
