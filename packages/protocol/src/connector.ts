import { z } from 'zod';
import { ENV_SECRET_REF_RE } from './secrets.ts';

/**
 * Connector manifests (ADR-0022). A connector is a typed, code-registered
 * description of an external surface (a source like GitHub, later tools).
 * Manifests carry env-var NAMES only — never a value — and exact setup
 * commands so "needs setup" is always actionable.
 */

/** An env-var NAME (UPPER_SNAKE_CASE). Mirrors the secret-ref charset. */
const envNameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(ENV_SECRET_REF_RE, 'env NAME (UPPER_SNAKE_CASE), never a value');

export const connectorManifestSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    kind: z.enum(['source', 'tool']),
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    capabilities: z.array(z.string().min(1).max(60)).max(20),
    requiredEnv: z.array(envNameSchema).max(10),
    optionalEnv: z.array(envNameSchema).max(10).optional(),
    setupCommands: z.array(z.string().min(1).max(300)).max(10),
    docsUrl: z.string().url().optional(),
    experimental: z.boolean().optional(),
  })
  .strict();

export type ConnectorManifest = z.infer<typeof connectorManifestSchema>;

/**
 * Live connector states (ADR-0022 §2). `connected` is only ever produced by a
 * successful live probe; `status_unknown` is the honest answer when a probe
 * is inconclusive. `needs_install`/`experimental` are reserved for CLI-backed
 * and pre-stable connectors.
 */
export const connectorRuntimeStateSchema = z.enum([
  'connected',
  'configured_but_failing',
  'needs_setup',
  'needs_install',
  'status_unknown',
  'experimental',
]);

export type ConnectorRuntimeState = z.infer<typeof connectorRuntimeStateSchema>;

/** What `connectors.status` returns per registered connector. Secret-free. */
export const connectorStatusReportSchema = z
  .object({
    manifest: connectorManifestSchema,
    state: connectorRuntimeStateSchema,
    detail: z.string().min(1).max(500),
    /** Required env NAMES that are absent (presence-checked only). */
    missingEnv: z.array(envNameSchema),
    /** Exact next command for the operator, when one is known. */
    nextCommand: z.string().max(300).optional(),
  })
  .strict();

export type ConnectorStatusReport = z.infer<typeof connectorStatusReportSchema>;
