import { z } from 'zod';
import { eventChannelSchema } from './events.ts';

/**
 * Skill registry contracts (ADR-0035). A skill is a governed capability
 * description: registry entry + permissions + docs are MANDATORY, enforced by
 * this schema — a directory without a valid manifest is never loadable.
 *
 * The registry registers and gates; it does not execute. `active` means
 * "registered and loadable", never "runnable" — Amrita has no skill executor
 * yet and every surface says so.
 */

export const skillTierSchema = z.enum(['system', 'shared', 'project']);
export type SkillTier = z.infer<typeof skillTierSchema>;

export const skillNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/, 'skill name must be a kebab-case slug');

/** Deny-by-default: an empty `toolsets` list grants nothing. */
export const skillPermissionsSchema = z
  .object({
    toolsets: z.array(z.string().min(1).max(40)).max(16),
    /** Channels allowed to invoke this skill; absent = every channel. */
    channels: z.array(eventChannelSchema).max(4).optional(),
  })
  .strict();
export type SkillPermissions = z.infer<typeof skillPermissionsSchema>;

export const skillManifestSchema = z
  .object({
    name: skillNameSchema,
    tier: skillTierSchema,
    version: z.string().min(1).max(20),
    description: z.string().min(10).max(300),
    owner: z.string().min(1).max(80),
    permissions: skillPermissionsSchema,
    /** Mandatory usage docs — a skill without docs is invalid (ADR-0035). */
    usage: z.string().min(20).max(4000),
  })
  .strict();
export type SkillManifest = z.infer<typeof skillManifestSchema>;

export const skillStateSchema = z.enum(['active', 'invalid', 'unregistered']);
export type SkillState = z.infer<typeof skillStateSchema>;

/** One registry row as reported over the wire. Value-free detail only. */
export const skillStatusSchema = z
  .object({
    name: z.string().min(1).max(80),
    tier: skillTierSchema,
    /** `builtin` for system skills, else the manifest's directory path. */
    source: z.string().min(1).max(400),
    state: skillStateSchema,
    detail: z.string().min(1).max(400),
    manifest: skillManifestSchema.optional(),
  })
  .strict();
export type SkillStatus = z.infer<typeof skillStatusSchema>;
