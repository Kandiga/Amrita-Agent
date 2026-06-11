import { z } from 'zod';
import { idSchema } from './ids.ts';

/**
 * The lane contract. A *lane* is a delegated unit of real work (e.g. a Claude
 * Code run) launched beside the conversation. The daemon hands a lane a
 * `LaneMandate` (what to do, within what scope and budget, with what approval
 * policy) and the lane returns a `MergeReport` (what it did, with what cost and
 * exit status). These two schemas are a hard boundary — see ADR-0001 D7.
 */

/** Token / cost accounting shared by usage events, mandates, and reports. */
export const usageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    usd: z.number().nonnegative().optional(),
  })
  .strict();
export type Usage = z.infer<typeof usageSchema>;

/** How a lane is allowed to reach outside its sandbox. */
export const networkPolicySchema = z.enum(['none', 'allowlist', 'open']);

/** What a lane does when it hits an action needing approval. */
export const approvalPolicySchema = z.enum(['forward', 'auto-safe', 'sandboxed']);

/** The context pack the daemon curates and hands to a lane. */
export const contextPackSchema = z
  .object({
    memory: z.array(z.string()).default([]),
    files: z.array(z.string()).default([]),
    decisions: z.array(z.string()).default([]),
  })
  .strict();
export type ContextPack = z.infer<typeof contextPackSchema>;

export const laneBudgetSchema = z
  .object({
    maxTurns: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxUsd: z.number().positive().optional(),
    maxMinutes: z.number().positive().optional(),
  })
  .strict();
export type LaneBudget = z.infer<typeof laneBudgetSchema>;

export const laneScopeSchema = z
  .object({
    paths: z.array(z.string()).optional(),
    repos: z.array(z.string()).optional(),
    network: networkPolicySchema.default('none'),
  })
  .strict();
export type LaneScope = z.infer<typeof laneScopeSchema>;

/** The mandate: everything a lane needs, and nothing it may exceed. */
export const laneMandateSchema = z
  .object({
    laneId: idSchema,
    goal: z.string().min(1).max(4000),
    contextPack: contextPackSchema,
    scope: laneScopeSchema,
    budget: laneBudgetSchema.default({}),
    approvals: approvalPolicySchema.default('forward'),
    deliverables: z.array(z.string()).default([]),
  })
  .strict();
export type LaneMandate = z.infer<typeof laneMandateSchema>;

// `cancelled` = a manual stop (operator/UI), distinct from `aborted` (a failure)
// and `budget` (a limit). See ADR-0015.
export const laneExitSchema = z.enum(['done', 'partial', 'aborted', 'budget', 'cancelled']);
export type LaneExit = z.infer<typeof laneExitSchema>;

export const mergeArtifactSchema = z
  .object({
    artifactId: idSchema,
    kind: z.string().min(1),
    path: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

/** The report: what a lane actually did, for the daemon to merge/summarize. */
export const mergeReportSchema = z
  .object({
    laneId: idSchema,
    summary: z.string().max(2000),
    artifacts: z.array(mergeArtifactSchema).default([]),
    decisions: z.array(z.string()).default([]),
    tasks: z.array(z.string()).default([]),
    followUps: z.array(z.string()).default([]),
    usage: usageSchema.default({ inputTokens: 0, outputTokens: 0 }),
    exit: laneExitSchema,
  })
  .strict();
export type MergeReport = z.infer<typeof mergeReportSchema>;
