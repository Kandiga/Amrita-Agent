import { z } from 'zod';
import {
  authModeSchema,
  connectorStatusSchema,
  laneRowStatusSchema,
  memoryScopeSchema,
  milestoneStatusSchema,
  questionStatusSchema,
  riskSeveritySchema,
  taskStatusSchema,
} from './events.ts';
import { idSchema, isoTimestampSchema } from './ids.ts';

/**
 * Row schemas for the persisted domain entities. These mirror the store tables
 * (see packages/store) and are the parsed shape returned across the daemon API.
 * The append-only event log is the source of truth; these are materialized
 * read-model rows. Extended to full wire coverage by ADR-0032.
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

/** A conversation with its lineage parent (ADR-0003 `parent_id`). */
export const conversationNodeSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string().nullable(),
  parentId: idSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  archivedAt: isoTimestampSchema.nullable(),
});
export type ConversationNode = z.infer<typeof conversationNodeSchema>;

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

// ── entity rows added for wire coverage (ADR-0032) ───────────────────────────
// Non-strict on purpose: the store may grow columns before the wire declares
// them; result parsing STRIPS undeclared keys (the defense-in-depth decision).

export const taskRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  conversationId: idSchema.nullable(),
  sourceMessageId: idSchema.nullable(),
  laneId: idSchema.nullable(),
  milestoneId: idSchema.nullable(),
  status: taskStatusSchema,
  title: z.string(),
  body: z.string().nullable(),
  externalRef: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type TaskRowWire = z.infer<typeof taskRowSchema>;

export const decisionRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  conversationId: idSchema.nullable(),
  sourceMessageId: idSchema.nullable(),
  supersedesId: idSchema.nullable(),
  text: z.string(),
  createdAt: isoTimestampSchema,
});
export type DecisionRowWire = z.infer<typeof decisionRowSchema>;

export const memoryEntryRowSchema = z.object({
  id: idSchema,
  scope: memoryScopeSchema,
  projectId: idSchema.nullable(),
  content: z.string(),
  charCount: z.number().int().nonnegative(),
  source: z.string().nullable(),
  sourceMessageId: idSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type MemoryEntryRowWire = z.infer<typeof memoryEntryRowSchema>;

export const projectBriefRowSchema = z.object({
  projectId: idSchema,
  goal: z.string(),
  audience: z.string().nullable(),
  successCriteria: z.array(z.string()),
  scope: z.array(z.string()),
  noScope: z.array(z.string()),
  sourceMessageId: idSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ProjectBriefRowWire = z.infer<typeof projectBriefRowSchema>;

export const openQuestionRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  conversationId: idSchema.nullable(),
  sourceMessageId: idSchema.nullable(),
  text: z.string(),
  status: questionStatusSchema,
  resolution: z.string().nullable(),
  resolvedByDecisionId: idSchema.nullable(),
  dropReason: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type OpenQuestionRowWire = z.infer<typeof openQuestionRowSchema>;

export const riskRowSchema = openQuestionRowSchema.extend({
  severity: riskSeveritySchema.nullable(),
});
export type RiskRowWire = z.infer<typeof riskRowSchema>;

export const milestoneRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  status: milestoneStatusSchema,
  targetDate: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type MilestoneRowWire = z.infer<typeof milestoneRowSchema>;

export const projectBrandRowSchema = z.object({
  projectId: idSchema,
  name: z.string().nullable(),
  audience: z.string().nullable(),
  tone: z.string().nullable(),
  styleNotes: z.array(z.string()),
  palette: z.array(z.string()),
  typography: z.string().nullable(),
  doNotUse: z.array(z.string()),
  sourceMessageId: idSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ProjectBrandRowWire = z.infer<typeof projectBrandRowSchema>;

export const previewApprovalRowSchema = z.object({
  projectId: idSchema,
  previewId: z.string(),
  contentHash: z.string(),
  sourceMessageId: idSchema.nullable(),
  approvedAt: isoTimestampSchema,
});
export type PreviewApprovalRowWire = z.infer<typeof previewApprovalRowSchema>;

export const connectorRowSchema = z.object({
  id: idSchema,
  slug: z.string(),
  kind: z.string(),
  status: connectorStatusSchema,
  manifestJson: z.string().nullable(),
  configJson: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type ConnectorRowWire = z.infer<typeof connectorRowSchema>;

/** `secretRef` is an env-var NAME, never a secret value (ADR-0003/0008). */
export const accountRowSchema = z.object({
  id: idSchema,
  provider: z.string(),
  label: z.string().nullable(),
  authMode: authModeSchema,
  secretRef: z.string().nullable(),
  metadataJson: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type AccountRowWire = z.infer<typeof accountRowSchema>;

export const laneRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  conversationId: idSchema,
  kind: z.string(),
  status: laneRowStatusSchema,
  mandateJson: z.string(),
  budgetJson: z.string().nullable(),
  mergeJson: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type LaneRowWire = z.infer<typeof laneRowSchema>;

export const pairingRowSchema = z.object({
  code: z.string(),
  channel: z.string(),
  projectId: idSchema,
  conversationId: idSchema.nullable(),
  claimedBy: z.string().nullable(),
  createdAt: isoTimestampSchema,
  claimedAt: isoTimestampSchema.nullable(),
});
export type PairingRowWire = z.infer<typeof pairingRowSchema>;
