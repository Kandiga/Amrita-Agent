import { z } from 'zod';
import {
  authModeSchema,
  certaintySchema,
  connectorStatusSchema,
  decisionRightSchema,
  derivationSchema,
  inboxConfidenceSchema,
  inboxKindSchema,
  inboxOriginSchema,
  inboxStatusSchema,
  laneRoleSchema,
  laneRowStatusSchema,
  memoryScopeSchema,
  milestoneStatusSchema,
  phaseStatusSchema,
  projectConstraintSchema,
  questionStatusSchema,
  riskSeveritySchema,
  taskPrioritySchema,
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
    /** When the operator approved activation (ADR-0045). Null = not started yet. */
    activatedAt: isoTimestampSchema.nullable(),
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
  // the board (ADR-0044). `blockedReason` non-null IS the "Waiting" column —
  // the status enum is deliberately not widened (see migration 0012).
  owner: z.string().nullable(),
  dueDate: z.string().nullable(),
  priority: taskPrioritySchema.nullable(),
  orderKey: z.string().nullable(),
  blockedReason: z.string().nullable(),
  /** Fact vs hypothesis (ADR-0045). `inferred` = Amrita worked it out. */
  certainty: certaintySchema.nullable(),
  /** The project phase this task lives in (ADR-0045) — where the board's columns come from. */
  phaseId: idSchema.nullable(),
  /** Optimistic-lock token (ADR-0045). Monotonic; a timestamp would collide. */
  version: z.number().int().nonnegative(),
  /** Why this card exists (ADR-0045) — the goal/constraint/decision it came from. */
  derivedFrom: z.array(derivationSchema),
  externalRef: z.string().nullable(),
  // ADR-0055 — evidence-based done: raw-JSON columns (the lanes `mandateJson`
  // pattern); consumers parse with `acceptanceCriterionSchema`/`taskVerificationSchema`.
  acceptanceJson: z.string().nullable(),
  verifiedAt: isoTimestampSchema.nullable(),
  verificationJson: z.string().nullable(),
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
  // the charter (ADR-0044) — the money, dates and decision rights a plan must
  // live within, plus an explicit definition of done
  finishLine: z.string().nullable(),
  constraints: z.array(projectConstraintSchema),
  decisionRights: z.array(decisionRightSchema),
  /** Per-field certainty (ADR-0045) — what the UI marks as certain / inferred. */
  certainty: z.record(z.string(), certaintySchema),
  /** Optimistic-lock token (ADR-0045). */
  version: z.number().int().nonnegative(),
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
  certainty: certaintySchema.nullable(), // ADR-0045
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type OpenQuestionRowWire = z.infer<typeof openQuestionRowSchema>;

export const riskRowSchema = openQuestionRowSchema.extend({
  severity: riskSeveritySchema.nullable(),
});
export type RiskRowWire = z.infer<typeof riskRowSchema>;

/** A live publication of the public hub (ADR-0045). */
export const publicationRowSchema = z.object({
  projectId: idSchema,
  publicSlug: z.string(),
  contentHash: z.string(),
  publishedAt: isoTimestampSchema,
  revokedAt: isoTimestampSchema.nullable(),
});
export type PublicationRowWire = z.infer<typeof publicationRowSchema>;

/** A phase — the project's own shape (ADR-0045). */
export const phaseRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  status: phaseStatusSchema,
  orderKey: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type PhaseRowWire = z.infer<typeof phaseRowSchema>;

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

/**
 * An Inbox item (ADR-0044) — a proposal awaiting triage.
 *
 * `promotedKind`/`promotedId` are non-null exactly when `status === 'triaged'`,
 * and `dismissReason` exactly when `status === 'dismissed'`. Both are enforced by
 * CHECK constraints in the store, so an item can never leave the queue without
 * saying what became of it.
 */
export const inboxItemRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  conversationId: idSchema.nullable(),
  sourceMessageId: idSchema.nullable(),
  origin: inboxOriginSchema,
  text: z.string(),
  suggestedKind: inboxKindSchema.nullable(),
  /** The proposed command payload, as stored. Validated at triage, not at capture. */
  suggested: z.record(z.string(), z.unknown()).nullable(),
  rationale: z.string().nullable(),
  confidence: inboxConfidenceSchema.nullable(),
  status: inboxStatusSchema,
  promotedKind: inboxKindSchema.nullable(),
  promotedId: idSchema.nullable(),
  dismissReason: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type InboxItemRowWire = z.infer<typeof inboxItemRowSchema>;

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
  // ADR-0053 dedupe key + ADR-0049 orchestration correlation. Nullable (the row
  // columns are nullable) and declared HERE so `lanes.get`/`lanes.list` never
  // silently strip what the store returns (a non-strict z.object drops unknowns).
  idempotencyKey: z.string().nullable(),
  groupId: z.string().nullable(),
  role: laneRoleSchema.nullable(),
  verifiesLaneId: z.string().nullable(),
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
