import { z } from 'zod';
import { idSchema, isoTimestampSchema } from './ids.ts';

/**
 * Cinema module contract — the MVP federation surface between the Cinema
 * Studio SPA (separate repo: aba-adama-studio) and the Amrita platform.
 *
 * Scope is deliberately four flat types (ADR-0028): a project reference, a
 * metadata-only digest, the plan-card shape (mirrored 1:1 from Cinema's
 * shipping `AgentPlan` — do not "improve" it here), and the verb vocabulary
 * (Cinema's server-whitelisted action + op types). The full module plane
 * (ModuleManifest, verb registry, module.op events) is a separate, future ADR.
 *
 * Hard rule carried by the digest schema itself: NO media bytes ever cross
 * this contract. Digests are summaries; images/audio stay in the module.
 */

/** Cinema project ids are module-local strings (not ULIDs) — validated loosely. */
export const cinemaProjectIdSchema = z.string().min(1).max(64);

/** Links one Cinema project to one Amrita project. */
export const cinemaProjectRefSchema = z
  .object({
    cinemaProjectId: cinemaProjectIdSchema,
    amritaProjectId: idSchema,
    name: z.string().min(1).max(200),
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type CinemaProjectRef = z.infer<typeof cinemaProjectRefSchema>;

/** Digest ceiling: serialized JSON must stay under the store's artifact-spill
 * threshold so a digest can always live inline in a memory entry. */
export const CINEMA_DIGEST_MAX_JSON_BYTES = 32_768;
const MEDIA_BYTES_RE = /data:|;base64,/;

/**
 * Metadata-only summary of a Cinema project for the Project Brain.
 * Counts + short text only. The schema itself rejects inlined media
 * (`data:`/base64 payloads) and oversized digests — this is the contract's
 * load-bearing safety rule, enforced at parse time on BOTH sides.
 */
export const cinemaProjectDigestSchema = z
  .object({
    cinemaProjectId: cinemaProjectIdSchema,
    amritaProjectId: idSchema.optional(),
    name: z.string().min(1).max(200),
    updatedAt: isoTimestampSchema,
    logline: z.string().max(500).optional(),
    style: z.string().max(300).optional(),
    shotCount: z.number().int().nonnegative(),
    storyboardFrameCount: z.number().int().nonnegative(),
    cardCount: z.number().int().nonnegative(),
    assetCounts: z
      .object({
        image: z.number().int().nonnegative().optional(),
        video: z.number().int().nonnegative().optional(),
        audio: z.number().int().nonnegative().optional(),
        music: z.number().int().nonnegative().optional(),
        voice: z.number().int().nonnegative().optional(),
        sfx: z.number().int().nonnegative().optional(),
        reference: z.number().int().nonnegative().optional(),
      })
      .strict(),
    timeline: z
      .object({
        clipCount: z.number().int().nonnegative(),
        durationSec: z.number().nonnegative(),
        laneClipCounts: z
          .object({
            video: z.number().int().nonnegative(),
            voice: z.number().int().nonnegative(),
            music: z.number().int().nonnegative(),
            sfx: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    qa: z
      .object({
        approved: z.number().int().nonnegative(),
        flagged: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Short human decision summaries (style/format choices, applied plans). */
    decisions: z.array(z.string().min(1).max(300)).max(20).default([]),
    /** Content hash of the digest source — the idempotency key for sync. */
    contentHash: z.string().min(1).max(64),
  })
  .strict()
  .refine((d) => !MEDIA_BYTES_RE.test(JSON.stringify(d)), {
    message: 'digest must not contain media bytes (data:/base64 payloads)',
  })
  .refine((d) => JSON.stringify(d).length < CINEMA_DIGEST_MAX_JSON_BYTES, {
    message: `digest JSON must stay under ${CINEMA_DIGEST_MAX_JSON_BYTES} bytes`,
  });
export type CinemaProjectDigest = z.infer<typeof cinemaProjectDigestSchema>;

/** Mirrors Cinema's shipping plan-card model 1:1 (app/src/video/agentActionPlan.ts). */
export const cinemaPlanRiskSchema = z.enum(['local', 'credit', 'destructive', 'ambiguous']);
export const cinemaPlanStatusSchema = z.enum(['ready', 'applied', 'discarded', 'failed']);
export const cinemaPlanKindSchema = z.enum([
  'generate',
  'create-generate',
  'timeline-combo',
  'compound-audio',
  'image-edit',
  'clip-batch',
  'batch-generate',
]);
export const cinemaPlanCardSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: cinemaPlanKindSchema,
    title: z.string().min(1).max(200),
    steps: z.array(z.string().min(1).max(300)).min(1).max(12),
    target: z.string().min(1).max(40), // card / asset / clip / timeline
    risk: cinemaPlanRiskSchema,
    status: cinemaPlanStatusSchema,
    prompt: z.string().max(8000).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CinemaPlanCard = z.infer<typeof cinemaPlanCardSchema>;

/**
 * Cinema's verb vocabulary as whitelisted by the module's own server logic
 * (brain-bridge/cinema-agent.mjs): proposed actions + immediately-applied ops.
 * Single source of truth for what a Cinema agent may do; anything else drops.
 */
export const CINEMA_ACTION_TYPES = [
  'update_shot_notes',
  'set_active_shot',
  'link_reference_to_shot',
  'use_as_reference',
  'generate_keyframe',
  'regenerate_keyframe',
  'edit_reference',
  'mark_qa',
  'export_prompt_pack',
  'build_plan',
  'apply_proposed_shots',
  'analyze_attachment',
  'fill_card',
  'arrange_canvas',
  'delete_asset',
  'create_skill',
  'apply_skill',
] as const;
export const CINEMA_VIDEO_OP_TYPES = [
  'setMeta',
  'addShot',
  'updateShot',
  'deleteShot',
  'reorderShots',
  'setShotNotes',
  'markQA',
  'linkReference',
] as const;
export const cinemaVerbSchema = z.enum([...CINEMA_ACTION_TYPES, ...CINEMA_VIDEO_OP_TYPES]);
export type CinemaVerb = z.infer<typeof cinemaVerbSchema>;

/**
 * Cinema mandates (ADR-0029) — Amrita delegates a goal to the Cinema module.
 * Cinema-scoped on purpose (YAGNI: generalize into a module plane only when
 * module #2 arrives). The module executes through its OWN trust model: verbs
 * above `maxRisk` surface as plan cards for the human — in-app Apply IS the
 * upward approval; nothing auto-spends beyond the ceiling.
 */
export const cinemaMandateSchema = z
  .object({
    mandateId: idSchema,
    goal: z.string().min(1).max(2000),
    /** Subset confinement; absent = the module's full whitelisted vocabulary. */
    allowedVerbs: z.array(cinemaVerbSchema).min(1).max(32).optional(),
    /** Risk ceiling for AUTO execution; above it a human must Apply in-app. */
    maxRisk: cinemaPlanRiskSchema.default('credit'),
    note: z.string().max(500).optional(),
    issuedAt: isoTimestampSchema,
  })
  .strict();
export type CinemaMandate = z.infer<typeof cinemaMandateSchema>;

export const cinemaMandateReportSchema = z
  .object({
    mandateId: idSchema,
    exit: z.enum(['done', 'partial', 'refused', 'aborted']),
    summary: z.string().min(1).max(2000),
    opsApplied: z.array(z.string().min(1).max(200)).max(40).default([]),
    plansApplied: z.array(z.string().min(1).max(120)).max(20).default([]),
    refusedReason: z.string().max(500).optional(),
  })
  .strict();
export type CinemaMandateReport = z.infer<typeof cinemaMandateReportSchema>;
