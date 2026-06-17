import { z } from 'zod';
import { isoTimestampSchema } from './ids.ts';

/**
 * The Organizational Brain Harness (ADR-0027). These are **view/spec** contracts
 * — the normalized knowledge layer the daemon derives from event-sourced state
 * and returns to the UI. They are not persisted-row schemas (yet): the brain is
 * a deterministic projection, like the surface artifacts. Provenance carries
 * source ids and refs only — never a secret value.
 *
 * See docs/strategy/organizational-brain-harness.md for the methodology.
 */

// ── knowledge records ────────────────────────────────────────────────────────

export const knowledgeRecordKindSchema = z.enum([
  'decision',
  'commitment',
  'meeting-note',
  'project-context',
  'open-question',
  'entity',
  'source-excerpt',
]);
export type KnowledgeRecordKind = z.infer<typeof knowledgeRecordKindSchema>;

export const knowledgeRecordStatusSchema = z.enum([
  'active',
  'resolved',
  'superseded',
  'stale',
  'contradicted',
]);
export type KnowledgeRecordStatus = z.infer<typeof knowledgeRecordStatusSchema>;

export const knowledgeConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type KnowledgeConfidence = z.infer<typeof knowledgeConfidenceSchema>;

/** Where a record came from. `sourceId` matches a KnowledgeSource id. */
export const knowledgeProvenanceSchema = z
  .object({
    sourceId: z.string().min(1),
    /** A human/external reference, e.g. `github:owner/repo#12` or a decision id. */
    ref: z.string().min(1).optional(),
    channel: z.enum(['web', 'telegram', 'cli', 'api']).optional(),
    capturedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type KnowledgeProvenance = z.infer<typeof knowledgeProvenanceSchema>;

export const knowledgeRecordSchema = z
  .object({
    /** Stable within a brain projection: `<kind>:<entityId>` (used as link target). */
    slug: z.string().min(1),
    kind: knowledgeRecordKindSchema,
    title: z.string().min(1).max(300),
    /** Normalized Markdown body. */
    body: z.string(),
    projectId: z.string().min(1),
    owner: z.string().min(1).nullable(),
    /** ISO date the knowledge pertains to (decision date, due date, …). */
    date: z.string().min(1).nullable(),
    confidence: knowledgeConfidenceSchema,
    tags: z.array(z.string().min(1)),
    /** Slugs of related records (the `[[links]]`). */
    links: z.array(z.string().min(1)),
    status: knowledgeRecordStatusSchema,
    provenance: knowledgeProvenanceSchema,
  })
  .strict();
export type KnowledgeRecord = z.infer<typeof knowledgeRecordSchema>;

// ── ingestion sources ────────────────────────────────────────────────────────

export const knowledgeSourceKindSchema = z.enum([
  'manual',
  'chat',
  'email',
  'calendar',
  'docs',
  'repo',
]);
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>;

/**
 * Honest ingestion status. `connected` is reserved for a source that really
 * ingests into the brain today; `manual` = import/capture by hand; `planned` =
 * designed but not built. Never green without real ingestion.
 */
export const knowledgeSourceStatusSchema = z.enum(['connected', 'manual', 'planned']);
export type KnowledgeSourceStatus = z.infer<typeof knowledgeSourceStatusSchema>;

export const knowledgeSourceSchema = z
  .object({
    id: z.string().min(1),
    kind: knowledgeSourceKindSchema,
    title: z.string().min(1),
    status: knowledgeSourceStatusSchema,
    detail: z.string().min(1),
    /** What this source extracts (commitments, decisions, action items, …). */
    extracts: z.array(z.string().min(1)),
    /** The exact next step to advance it (e.g. a setup command), when relevant. */
    nextStep: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

// ── knowledge gaps ───────────────────────────────────────────────────────────

export const knowledgeGapKindSchema = z.enum([
  'missing-owner',
  'missing-date',
  'missing-source',
  'orphan',
  'unresolved-question',
  'stale',
  'contradiction',
]);
export type KnowledgeGapKind = z.infer<typeof knowledgeGapKindSchema>;

export const knowledgeGapSchema = z
  .object({
    kind: knowledgeGapKindSchema,
    severity: z.enum(['low', 'medium', 'high']),
    /** The record this gap is about, when it concerns one. */
    recordSlug: z.string().min(1).optional(),
    detail: z.string().min(1),
  })
  .strict();
export type KnowledgeGap = z.infer<typeof knowledgeGapSchema>;

// ── harness topology (harness-as-code) ───────────────────────────────────────

export const harnessAgentRoleSchema = z.enum(['ingest', 'link', 'maintain', 'answer']);
export type HarnessAgentRole = z.infer<typeof harnessAgentRoleSchema>;

export const harnessAgentSchema = z
  .object({
    id: z.string().min(1),
    role: harnessAgentRoleSchema,
    title: z.string().min(1),
    /** Source kinds this agent ingests (ingest agents only). */
    ingests: z.array(knowledgeSourceKindSchema).optional(),
    /** Record kinds this agent maintains (link/maintain agents). */
    maintains: z.array(knowledgeRecordKindSchema).optional(),
    trigger: z.string().min(1),
    outputs: z.array(z.string().min(1)),
    qualityChecks: z.array(z.string().min(1)),
    /** `active` = implemented today; `planned` = designed, not built. */
    status: z.enum(['active', 'planned']),
  })
  .strict();
export type HarnessAgent = z.infer<typeof harnessAgentSchema>;

export const harnessTopologySchema = z
  .object({
    version: z.number().int().positive(),
    agents: z.array(harnessAgentSchema).min(1),
  })
  .strict();
export type HarnessTopology = z.infer<typeof harnessTopologySchema>;

// ── assembled brain view ─────────────────────────────────────────────────────

export const maintenanceEventSchema = z
  .object({
    ts: isoTimestampSchema,
    /** The harness role that would own this maintenance action. */
    agent: harnessAgentRoleSchema,
    action: z.string().min(1),
    detail: z.string().min(1),
    recordSlug: z.string().min(1).optional(),
  })
  .strict();
export type MaintenanceEvent = z.infer<typeof maintenanceEventSchema>;

export const projectBrainSchema = z
  .object({
    projectId: z.string().min(1),
    records: z.array(knowledgeRecordSchema),
    gaps: z.array(knowledgeGapSchema),
    sources: z.array(knowledgeSourceSchema),
    maintenance: z.array(maintenanceEventSchema),
    counts: z
      .object({
        records: z.number().int().nonnegative(),
        gaps: z.number().int().nonnegative(),
        sourcesConnected: z.number().int().nonnegative(),
        sourcesManual: z.number().int().nonnegative(),
        sourcesPlanned: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ProjectBrain = z.infer<typeof projectBrainSchema>;
