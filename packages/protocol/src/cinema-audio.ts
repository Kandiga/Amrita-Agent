import { z } from 'zod';
import { isoTimestampSchema } from './ids.ts';

/**
 * Canonical Cinema app↔bridge contracts for video-grounded audio.
 *
 * These records contain metadata, hashes, evidence references and reversible
 * operations only. Exporting a schema from @amrita/protocol does NOT make it a
 * federation payload; cinemaProjectDigestSchema remains the sole project-brain
 * digest and still rejects media bytes.
 */

const localIdSchema = z.string().min(1).max(128);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'expected a SHA-256 hex digest');

const secondsSpanFields = {
  startSec: z.number().finite().nonnegative(),
  endSec: z.number().finite().nonnegative(),
};

export const timeRangeSchema = z
  .object(secondsSpanFields)
  .strict()
  .superRefine((value, ctx) => {
    if (value.endSec < value.startSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endSec must be >= startSec',
        path: ['endSec'],
      });
    }
  });
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const evidenceRefSchema = z
  .object({
    id: localIdSchema,
    sourceHash: sha256Schema,
    ...secondsSpanFields,
    modality: z.enum(['video', 'audio', 'asr', 'ocr', 'metadata']),
    analyzerVersion: z.string().min(1).max(128),
    claimClass: z.enum([
      'OBSERVED_VIDEO',
      'MEASURED',
      'OFFICIAL_CLAIM',
      'INFERRED',
      'UNKNOWN',
      'PROPOSED',
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endSec < value.startSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endSec must be >= startSec',
        path: ['endSec'],
      });
    }
  });
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

const evidenceIdsSchema = z.array(localIdSchema).min(1).max(256);

const sceneSpanSchema = z
  .object({ id: localIdSchema, ...secondsSpanFields, evidenceRefs: evidenceIdsSchema })
  .strict()
  .refine((value) => value.endSec >= value.startSec, {
    message: 'invalid scene range',
    path: ['endSec'],
  });

const speechSpanSchema = z
  .object({
    id: localIdSchema,
    ...secondsSpanFields,
    text: z.string().max(20_000).optional(),
    evidenceRefs: evidenceIdsSchema,
  })
  .strict()
  .refine((value) => value.endSec >= value.startSec, {
    message: 'invalid speech range',
    path: ['endSec'],
  });

const ocrSpanSchema = z
  .object({
    id: localIdSchema,
    ...secondsSpanFields,
    text: z.string().max(20_000),
    evidenceRefs: evidenceIdsSchema,
  })
  .strict()
  .refine((value) => value.endSec >= value.startSec, {
    message: 'invalid OCR range',
    path: ['endSec'],
  });

const evidenceEventSchema = z
  .object({
    id: localIdSchema,
    label: z.string().min(1).max(500),
    ...secondsSpanFields,
    evidenceRefs: evidenceIdsSchema,
  })
  .strict()
  .refine((value) => value.endSec >= value.startSec, {
    message: 'invalid event range',
    path: ['endSec'],
  });

const moodPointSchema = z
  .object({
    atSec: z.number().finite().nonnegative(),
    valence: z.number().finite().min(-1).max(1),
    arousal: z.number().finite().min(0).max(1),
    evidenceRefs: evidenceIdsSchema,
  })
  .strict();

const tempoHintSchema = z
  .object({
    range: timeRangeSchema,
    bpm: z.number().finite().positive().max(400).optional(),
    confidence: z.number().finite().min(0).max(1),
    evidenceRefs: evidenceIdsSchema,
  })
  .strict();

const analysisUnknownSchema = z
  .object({
    code: z.string().min(1).max(128),
    detail: z.string().min(1).max(2000),
    range: timeRangeSchema.optional(),
  })
  .strict();
const analysisWarningSchema = z
  .object({ code: z.string().min(1).max(128), detail: z.string().min(1).max(2000) })
  .strict();

export const videoAnalysisRecordSchema = z
  .object({
    id: localIdSchema,
    projectId: localIdSchema,
    sourceAssetId: localIdSchema,
    sourceHash: sha256Schema,
    sourceDurationSec: z.number().finite().positive(),
    timebase: z.literal('seconds'),
    analyzerVersion: z.string().min(1).max(128),
    createdAt: isoTimestampSchema,
    scenes: z.array(sceneSpanSchema).max(10_000),
    cuts: z.array(z.number().finite().nonnegative()).max(50_000),
    speech: z.array(speechSpanSchema).max(50_000),
    textSpans: z.array(ocrSpanSchema).max(50_000),
    events: z.array(evidenceEventSchema).max(50_000),
    moodArc: z.array(moodPointSchema).max(50_000),
    tempoHints: z.array(tempoHintSchema).max(10_000),
    dialogueRanges: z.array(timeRangeSchema).max(50_000),
    unknowns: z.array(analysisUnknownSchema).max(10_000),
    warnings: z.array(analysisWarningSchema).max(10_000),
    evidenceIndex: z.record(z.string(), evidenceRefSchema),
    externalEnrichment: z
      .object({
        provider: z.string().min(1).max(128),
        model: z.string().min(1).max(256),
        sentRanges: z.array(timeRangeSchema).min(1).max(256),
        retentionPolicySnapshotId: localIdSchema,
        consentId: localIdSchema,
      })
      .strict()
      .optional(),
    contentHash: sha256Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const evidenceIds = new Set(Object.keys(value.evidenceIndex));
    if (evidenceIds.size > 100_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evidence index exceeds 100000 entries',
        path: ['evidenceIndex'],
      });
    }
    const refs = [
      ...value.scenes.flatMap((entry) => entry.evidenceRefs),
      ...value.speech.flatMap((entry) => entry.evidenceRefs),
      ...value.textSpans.flatMap((entry) => entry.evidenceRefs),
      ...value.events.flatMap((entry) => entry.evidenceRefs),
      ...value.moodArc.flatMap((entry) => entry.evidenceRefs),
      ...value.tempoHints.flatMap((entry) => entry.evidenceRefs),
    ];
    for (const ref of refs) {
      if (!evidenceIds.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown evidence ref: ${ref}`,
          path: ['evidenceIndex'],
        });
      }
    }
    for (const [key, ref] of Object.entries(value.evidenceIndex)) {
      if (ref.id !== key) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidence key/id mismatch: ${key}`,
          path: ['evidenceIndex', key, 'id'],
        });
      }
      if (ref.sourceHash !== value.sourceHash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidence source hash mismatch: ${key}`,
          path: ['evidenceIndex', key, 'sourceHash'],
        });
      }
      if (ref.endSec > value.sourceDurationSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `evidence exceeds source duration: ${key}`,
          path: ['evidenceIndex', key, 'endSec'],
        });
      }
    }
  });
export type VideoAnalysisRecord = z.infer<typeof videoAnalysisRecordSchema>;

export const planCritiqueSchema = z
  .object({
    pass: z.boolean(),
    issues: z
      .array(
        z
          .object({
            severity: z.enum(['P0', 'P1', 'P2']),
            code: z.string().min(1).max(128),
            detail: z.string().min(1).max(2000),
            cueId: localIdSchema.optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

export const costEnvelopeSchema = z
  .object({
    currency: z.string().min(3).max(16),
    estimatedAmount: z.number().finite().nonnegative(),
    maxApprovedAmount: z.number().finite().nonnegative(),
    providerIds: z.array(localIdSchema).min(1).max(32),
    candidateCount: z.number().int().positive().max(128),
    expiresAt: isoTimestampSchema.optional(),
  })
  .strict()
  .refine((value) => value.maxApprovedAmount >= value.estimatedAmount, {
    message: 'maxApprovedAmount must cover estimatedAmount',
    path: ['maxApprovedAmount'],
  });

export const privacyRouteSchema = z
  .object({
    mode: z.enum(['standard', 'confidential']),
    egress: z.enum(['none', 'range_proxy']),
    providers: z.array(localIdSchema).max(32),
    consentId: localIdSchema.optional(),
    sentRanges: z.array(timeRangeSchema).max(256),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === 'confidential' && value.egress !== 'none') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'confidential mode forbids external egress',
        path: ['egress'],
      });
    }
    if (value.egress === 'range_proxy' && !value.consentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'range proxy egress requires consent',
        path: ['consentId'],
      });
    }
  });

export const audioCueSchema = z
  .object({
    cueId: localIdSchema,
    kind: z.enum(['music', 'sfx', 'ambience', 'foley']),
    ...secondsSpanFields,
    anchorSec: z.number().finite().nonnegative(),
    intent: z.string().min(1).max(2000),
    prompt: z.string().min(1).max(20_000),
    negativePrompt: z.string().max(10_000),
    evidenceRefs: evidenceIdsSchema,
    dialoguePolicy: z.enum(['preserve', 'duck', 'allow_overlap', 'no_dialogue']),
    fadeInSec: z.number().finite().nonnegative().max(30),
    fadeOutSec: z.number().finite().nonnegative().max(30),
    targetLufs: z.number().finite().min(-70).max(0),
    providerConstraints: z.array(localIdSchema).min(1).max(32),
    candidateCount: z.number().int().positive().max(8),
    confidence: z.number().finite().min(0).max(1),
    warnings: z.array(z.string().max(2000)).max(100),
    requiresReview: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endSec < value.startSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endSec must be >= startSec',
        path: ['endSec'],
      });
    }
    if (value.anchorSec < value.startSec || value.anchorSec > value.endSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'anchorSec must be inside cue range',
        path: ['anchorSec'],
      });
    }
  });
export type AudioCue = z.infer<typeof audioCueSchema>;

// Conservative Phase 0 defaults: SFX/foley/ambience audition one candidate,
// music two. Plan generators start here; the approval envelope still binds
// whatever count is actually approved.
export const DEFAULT_CANDIDATE_COUNT_BY_KIND = Object.freeze({
  music: 2,
  sfx: 1,
  ambience: 1,
  foley: 1,
} as const satisfies Record<AudioCue['kind'], number>);

export const audioCuePlanSchema = z
  .object({
    id: localIdSchema,
    projectId: localIdSchema,
    projectVersion: z.number().int().nonnegative(),
    sourceHash: sha256Schema,
    analysisHash: sha256Schema,
    mode: z.enum(['quick', 'plan']),
    requestText: z.string().min(1).max(20_000),
    resolvedRange: timeRangeSchema,
    cues: z.array(audioCueSchema).min(1).max(128),
    critic: planCritiqueSchema,
    costEstimate: costEnvelopeSchema,
    privacyRoute: privacyRouteSchema,
    status: z.enum(['draft', 'review', 'approved', 'superseded']),
    approvalHash: sha256Schema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'approved' && !value.approvalHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved plan requires approvalHash',
        path: ['approvalHash'],
      });
    }
    if (
      value.status === 'approved' &&
      (!value.critic.pass || value.critic.issues.some((issue) => issue.severity === 'P0'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'approved plan requires a passing critic with no P0 issues',
        path: ['critic'],
      });
    }
    const candidateCount = value.cues.reduce((total, cue) => total + cue.candidateCount, 0);
    if (candidateCount !== value.costEstimate.candidateCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cue candidate count must match the approved cost envelope',
        path: ['costEstimate', 'candidateCount'],
      });
    }
    const costProviders = new Set(value.costEstimate.providerIds);
    const privacyProviders = new Set(value.privacyRoute.providers);
    for (const [index, cue] of value.cues.entries()) {
      if (cue.startSec < value.resolvedRange.startSec || cue.endSec > value.resolvedRange.endSec) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'cue must remain inside resolvedRange',
          path: ['cues', index],
        });
      }
      for (const provider of cue.providerConstraints) {
        if (!costProviders.has(provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `provider is outside the approved cost envelope: ${provider}`,
            path: ['cues', index, 'providerConstraints'],
          });
        }
        if (value.privacyRoute.egress === 'range_proxy' && !privacyProviders.has(provider)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `provider is outside the approved privacy route: ${provider}`,
            path: ['cues', index, 'providerConstraints'],
          });
        }
      }
    }
  });
export type AudioCuePlan = z.infer<typeof audioCuePlanSchema>;

export const moneySchema = z
  .object({ amount: z.number().finite().nonnegative(), currency: z.string().min(3).max(16) })
  .strict();

const jobAttemptSchema = z
  .object({
    number: z.number().int().positive(),
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema.optional(),
    state: z.enum([
      'reserved',
      'submitting',
      'submitted',
      'running',
      'succeeded',
      'failed',
      'ambiguous',
    ]),
    providerRequestId: z.string().min(1).max(512).optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

export const audioGenerationJobSchema = z
  .object({
    id: localIdSchema,
    idempotencyKey: sha256Schema,
    projectId: localIdSchema,
    planId: localIdSchema,
    cueId: localIdSchema,
    candidateIndex: z.number().int().nonnegative().max(7),
    provider: localIdSchema,
    model: z.string().min(1).max(256),
    adapterVersion: z.string().min(1).max(128),
    status: z.enum([
      'queued',
      'submitting',
      'submitted',
      'running',
      'needs_reconciliation',
      'cancel_requested',
      'cancelled',
      'completed_uncancellable',
      'succeeded',
      'failed',
      'superseded',
    ]),
    providerRequestId: z.string().min(1).max(512).optional(),
    inputHash: sha256Schema,
    outputAssetId: localIdSchema.optional(),
    estimate: moneySchema,
    actual: moneySchema.optional(),
    receiptId: localIdSchema.optional(),
    attempts: z.array(jobAttemptSchema).max(100),
    retentionUntil: isoTimestampSchema.optional(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (['submitted', 'running'].includes(value.status) && !value.providerRequestId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${value.status} job requires providerRequestId`,
        path: ['providerRequestId'],
      });
    }
    if (['succeeded', 'completed_uncancellable'].includes(value.status)) {
      if (!value.outputAssetId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.status} job requires outputAssetId`,
          path: ['outputAssetId'],
        });
      }
      if (!value.receiptId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${value.status} job requires receiptId`,
          path: ['receiptId'],
        });
      }
    }
  });
export type AudioGenerationJob = z.infer<typeof audioGenerationJobSchema>;

export const audioCandidateSchema = z
  .object({
    id: localIdSchema,
    jobId: localIdSchema,
    projectId: localIdSchema,
    planId: localIdSchema,
    cueId: localIdSchema,
    assetId: localIdSchema,
    sourceHash: sha256Schema,
    sourceRange: timeRangeSchema,
    provider: localIdSchema,
    model: z.string().min(1).max(256),
    adapterVersion: z.string().min(1).max(128),
    promptHash: sha256Schema,
    parametersHash: sha256Schema,
    licenseSnapshotId: localIdSchema,
    retentionSnapshotId: localIdSchema,
    cost: moneySchema,
    checksum: sha256Schema,
    approvalState: z.enum(['pending', 'accepted', 'rejected', 'superseded']),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type AudioCandidate = z.infer<typeof audioCandidateSchema>;

export const timelineOperationSchema = z
  .object({
    op: z.enum(['addClip', 'removeClip', 'updateClip', 'setGain', 'setFade', 'setDucking']),
    targetId: localIdSchema.optional(),
    assetId: localIdSchema.optional(),
    trackId: localIdSchema.optional(),
    startSec: z.number().finite().nonnegative().optional(),
    durationSec: z.number().finite().positive().optional(),
    value: z.number().finite().optional(),
    payload: z
      .record(z.string(), z.unknown())
      .refine(
        (payload) => {
          try {
            const serialized = JSON.stringify(payload);
            return serialized.length <= 32_768 && !/data:[^;,]{0,64};base64,/.test(serialized);
          } catch {
            return false;
          }
        },
        { message: 'payload must stay under 32 KiB of metadata with no media bytes' },
      )
      .optional(),
  })
  .strict();
export type TimelineOperation = z.infer<typeof timelineOperationSchema>;

export const timelinePatchSchema = z
  .object({
    id: localIdSchema,
    projectId: localIdSchema,
    precondition: z
      .object({
        projectVersion: z.number().int().nonnegative(),
        sourceHash: sha256Schema,
        analysisHash: sha256Schema,
      })
      .strict(),
    operations: z.array(timelineOperationSchema).min(1).max(1000),
    inverseOperations: z.array(timelineOperationSchema).min(1).max(1000),
    assetIds: z.array(localIdSchema).max(1000),
    planId: localIdSchema,
    idempotencyKey: sha256Schema,
    status: z.enum(['staged', 'applied', 'rejected_stale', 'rolled_back']),
  })
  .strict();
export type TimelinePatch = z.infer<typeof timelinePatchSchema>;

export const generationReceiptSchema = z
  .object({
    id: localIdSchema,
    jobId: localIdSchema,
    sourceHash: sha256Schema,
    sourceRange: timeRangeSchema,
    analysisHash: sha256Schema,
    planHash: sha256Schema,
    promptHash: sha256Schema,
    provider: localIdSchema,
    model: z.string().min(1).max(256),
    adapterVersion: z.string().min(1).max(128),
    compiledPromptRedacted: z.string().max(20_000),
    negativePromptRedacted: z.string().max(10_000),
    seed: z.union([z.string().max(256), z.number().int()]).optional(),
    parametersHash: sha256Schema,
    candidateIndex: z.number().int().nonnegative().max(7),
    providerRequestId: z.string().min(1).max(512).optional(),
    estimate: moneySchema,
    actual: moneySchema.optional(),
    termsSnapshotId: localIdSchema,
    licenseSnapshotId: localIdSchema,
    retentionSnapshotId: localIdSchema,
    consentId: localIdSchema,
    approvalHash: sha256Schema,
    outputHash: sha256Schema,
    timelinePatchId: localIdSchema.optional(),
    retentionOutcome: z.enum([
      'retained_first_party',
      'provider_deleted',
      'provider_retention_pending',
      'provider_retention_unknown',
    ]),
    deletionReceiptId: localIdSchema.optional(),
    createdAt: isoTimestampSchema,
  })
  .strict();
export type GenerationReceipt = z.infer<typeof generationReceiptSchema>;
