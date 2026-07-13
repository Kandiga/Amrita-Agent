import { z } from 'zod';
import { cinemaMandateReportSchema, cinemaMandateSchema } from './cinema.ts';
import { connectorStatusReportSchema } from './connector.ts';
import {
  accountRowSchema,
  connectorRowSchema,
  conversationNodeSchema,
  conversationRowSchema,
  decisionRowSchema,
  laneRowSchema,
  memoryEntryRowSchema,
  milestoneRowSchema,
  openQuestionRowSchema,
  pairingRowSchema,
  previewApprovalRowSchema,
  projectBrandRowSchema,
  projectBriefRowSchema,
  projectRowSchema,
  riskRowSchema,
  taskRowSchema,
} from './entities.ts';
import {
  authModeSchema,
  laneRowStatusSchema,
  providerConfigStatusSchema,
  providerRoleSchema,
  riskSeveritySchema,
  sealedEventShellSchema,
} from './events.ts';
import { harnessTopologySchema, knowledgeSourceSchema, projectBrainSchema } from './harness.ts';
import { idSchema, isoTimestampSchema } from './ids.ts';
import { mergeReportSchema } from './lane.ts';
import { skillStatusSchema } from './skill.ts';

/**
 * The daemon↔client wire contract (ADR-0032). This module describes the REAL
 * transport — `POST /rpc` request/response envelopes, the `/events/ws` frame
 * union, and a result schema for EVERY RPC method — so nothing crosses the
 * daemon→client boundary unparsed. The daemon parses results on the way out
 * (dispatch), clients parse on the way in.
 *
 * Result parsing STRIPS undeclared keys by design: a new kernel field reaches
 * clients only once it is declared here. Adding an RPC method without a result
 * schema fails the coverage fitness test in @amrita/daemon.
 */

// ── RPC envelopes ─────────────────────────────────────────────────────────────

export const RPC_ERROR_CODES = [
  'invalid_request',
  'unknown_method',
  'invalid_params',
  'not_found',
  'conflict',
  'provider_unavailable',
  'provider_error',
  'missing_secret_ref',
  'missing_env_value',
  'internal',
] as const;
export const rpcErrorCodeSchema = z.enum(RPC_ERROR_CODES);
export type RpcErrorCode = z.infer<typeof rpcErrorCodeSchema>;

const rpcIdSchema = z.union([z.string(), z.number(), z.null()]);
export type RpcId = z.infer<typeof rpcIdSchema>;

/** Unknown keys (e.g. a client's `jsonrpc: "2.0"`) are stripped, not rejected. */
export const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

export const rpcSuccessSchema = z.object({
  id: rpcIdSchema,
  result: z.unknown(),
});
export type RpcSuccessFrame = z.infer<typeof rpcSuccessSchema>;

export const rpcErrorResponseSchema = z.object({
  id: rpcIdSchema,
  error: z.object({
    code: rpcErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type RpcErrorFrame = z.infer<typeof rpcErrorResponseSchema>;

export const rpcResponseSchema = z.union([rpcErrorResponseSchema, rpcSuccessSchema]);
export type RpcResponseFrame = z.infer<typeof rpcResponseSchema>;

export function parseRpcResponse(input: unknown): RpcResponseFrame {
  return rpcResponseSchema.parse(input);
}

// ── WS stream frames (`/events/ws`) ──────────────────────────────────────────

export const wsServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('event'), event: sealedEventShellSchema }),
  z.object({
    t: z.literal('replayed'),
    conversationId: idSchema,
    sinceSeq: z.number().int().nonnegative(),
  }),
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;

export function parseWsServerFrame(input: unknown): WsServerFrame {
  return wsServerFrameSchema.parse(input);
}

// ── daemon view shapes (returned by RPC, owned here since ADR-0032) ──────────

const okTrueSchema = z.object({ ok: z.literal(true) });

export const kernelHealthSchema = z.object({
  ok: z.literal(true),
  name: z.literal('amritad'),
  startedAt: isoTimestampSchema,
  dbPath: z.string(),
  schemaVersion: z.number().int(),
  counts: z.object({
    projects: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
  }),
  lanes: z.object({ realExecution: z.boolean(), active: z.number().int().nonnegative() }),
});
export type KernelHealthWire = z.infer<typeof kernelHealthSchema>;

export const doctorStatusSchema = z.enum(['ok', 'warn', 'fail']);
export type DoctorStatus = z.infer<typeof doctorStatusSchema>;

export const doctorCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: doctorStatusSchema,
  detail: z.string().optional(),
  fix: z.string().optional(),
});
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const doctorSectionSchema = z.object({
  title: z.string(),
  checks: z.array(doctorCheckSchema),
});
export type DoctorSection = z.infer<typeof doctorSectionSchema>;

export const doctorReportSchema = z.object({
  ok: z.boolean(),
  status: doctorStatusSchema,
  sections: z.array(doctorSectionSchema),
  fixes: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

export const codingRuntimeStateSchema = z.enum([
  'ready',
  'installed_unauthenticated',
  'installed_auth_unknown',
  'not_installed',
  'status_unknown',
]);
export type CodingRuntimeState = z.infer<typeof codingRuntimeStateSchema>;

export const codingRuntimeStatusSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: codingRuntimeStateSchema,
  version: z.string().optional(),
  realExecution: z.boolean(),
  detail: z.string(),
  nextCommand: z.string().optional(),
  /** Tool NAMES a real lane may use for this runtime (ADR-0043). Never secret-shaped —
   *  presence/absence of a tool is operational config, not a credential. claude-code
   *  only: codex sandboxes by directory, not by tool allowlist. */
  allowedTools: z.array(z.string()).optional(),
});
export type CodingRuntimeStatusWire = z.infer<typeof codingRuntimeStatusSchema>;

export const providerGroupSchema = z.enum(['login', 'api_key', 'local']);
export type ProviderGroup = z.infer<typeof providerGroupSchema>;

export const providerInfoSchema = z.object({
  id: z.string(),
  kind: z.enum(['mock', 'real']),
  available: z.boolean(),
  configuredAccounts: z.number().int().nonnegative(),
  envReady: z.boolean(),
  streaming: z.boolean(),
  title: z.string().optional(),
  group: providerGroupSchema.optional(),
  authMode: authModeSchema.optional(),
  executable: z.boolean().optional(),
});
export type ProviderInfoWire = z.infer<typeof providerInfoSchema>;

export const providerCatalogStateSchema = z.enum([
  'ready',
  'needs_key',
  'needs_login',
  'missing_cli',
  'needs_endpoint',
  'unavailable',
]);
export type ProviderCatalogState = z.infer<typeof providerCatalogStateSchema>;

/** One chooser-UI entry from `providers.catalog` (ADR-0025). Value-free. */
export const providerCatalogEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  group: providerGroupSchema,
  authMode: authModeSchema,
  defaultModel: z.string(),
  executable: z.boolean(),
  envName: z.string().optional(),
  keyUrl: z.string().optional(),
  installHint: z.string().optional(),
  state: providerCatalogStateSchema,
  detail: z.string(),
  fix: z.string().optional(),
});
export type ProviderCatalogEntryWire = z.infer<typeof providerCatalogEntrySchema>;

export const roleBindingSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
});
export type RoleBindingWire = z.infer<typeof roleBindingSchema>;

/** One role's resolution: project binding > global binding > auto (ADR-0017/0019). */
export const roleResolutionSchema = z.object({
  role: providerRoleSchema,
  binding: roleBindingSchema.nullable(),
  projectBinding: roleBindingSchema.nullable(),
  resolvesTo: z.string(),
  model: z.string().optional(),
  via: z.enum(['project', 'binding', 'auto']),
});
export type RoleResolution = z.infer<typeof roleResolutionSchema>;

export const runtimeStatusSchema = z.object({
  roles: z.array(roleResolutionSchema),
  providers: z.array(providerInfoSchema),
  codingRuntimes: z.array(codingRuntimeStatusSchema),
});
export type RuntimeStatusWire = z.infer<typeof runtimeStatusSchema>;

export const modelDiscoveryResultSchema = z.object({
  provider: z.string(),
  models: z.array(z.string()),
  source: z.enum(['live', 'curated']),
  detail: z.string(),
});

export const probeEndpointResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(z.string()),
  probedUrl: z.string(),
  detail: z.string(),
  suggestedUrl: z.string().optional(),
});

export const chatUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const chatTurnResultSchema = z.object({
  turnId: idSchema,
  provider: z.string(),
  model: z.string(),
  role: providerRoleSchema,
  userMessageId: idSchema,
  userEvent: sealedEventShellSchema,
  dryRun: z.boolean(),
  assistantMessageId: idSchema.nullable(),
  assistantEvent: sealedEventShellSchema.nullable(),
  text: z.string().nullable(),
  finishReason: z.string().nullable(),
  usage: chatUsageSchema.nullable(),
});
export type ChatTurnResultWire = z.infer<typeof chatTurnResultSchema>;

export const laneStartResultSchema = z.object({
  laneId: idSchema,
  status: laneRowStatusSchema,
  dryRun: z.boolean(),
  detached: z.boolean(),
  report: mergeReportSchema.nullable(),
  error: z.string().optional(),
});
export type LaneStartResultWire = z.infer<typeof laneStartResultSchema>;

export const laneCancelResultSchema = z.object({
  laneId: idSchema,
  cancelled: z.boolean(),
  status: laneRowStatusSchema.nullable(),
});
export type LaneCancelResultWire = z.infer<typeof laneCancelResultSchema>;

/** A pending operator approval (ADR-0021). Runtime state; events are the audit. */
export const pendingApprovalSchema = z.object({
  approvalId: idSchema,
  action: z.string(),
  detail: z.string().optional(),
  projectId: idSchema,
  conversationId: idSchema,
  laneId: idSchema.optional(),
  requestedAt: isoTimestampSchema,
});
export type PendingApprovalWire = z.infer<typeof pendingApprovalSchema>;

export const companionStateSchema = z.object({
  brief: projectBriefRowSchema.nullable(),
  brand: projectBrandRowSchema.nullable(),
  questions: z.array(openQuestionRowSchema),
  risks: z.array(riskRowSchema),
  milestones: z.array(milestoneRowSchema),
  previewApprovals: z.array(previewApprovalRowSchema),
});
export type CompanionStateWire = z.infer<typeof companionStateSchema>;

export const githubImportResultSchema = z.object({
  repo: z.string(),
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  tasks: z.array(z.object({ taskId: idSchema, externalRef: z.string(), title: z.string() })),
});

export const channelStatusEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  ready: z.boolean(),
  status: z.enum(['ready', 'needs_setup']),
  note: z.string(),
});

export const cinemaMandateRowSchema = z.object({
  mandate: cinemaMandateSchema,
  status: z.enum(['open', 'resolved']),
  report: cinemaMandateReportSchema.optional(),
});

/** Scheduler two-signal heartbeat + typed jobs (ADR-0036). */
export const schedulerStatusSchema = z.object({
  running: z.boolean(),
  lastTickAt: isoTimestampSchema.nullable(),
  lastSuccessAt: isoTimestampSchema.nullable(),
  jobs: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        title: z.string(),
        intervalMinutes: z.number().int().positive(),
        enabled: z.boolean(),
        lastRunAt: isoTimestampSchema.nullable(),
        lastOutcome: z.enum(['ok', 'problem', 'error']).nullable(),
      }),
    )
    .max(20),
});
export type SchedulerStatusWire = z.infer<typeof schedulerStatusSchema>;

/** System Brain verbs (ADR-0036): health / audit / plan / manage. */
export const systemHealthResultSchema = z.object({
  ok: z.boolean(),
  doctor: doctorReportSchema,
  scheduler: schedulerStatusSchema.nullable(),
  projects: z.array(
    z.object({
      id: idSchema,
      slug: z.string(),
      name: z.string(),
      records: z.number().int().nonnegative(),
      gaps: z.number().int().nonnegative(),
    }),
  ),
});

export const systemAuditFindingSchema = z.object({
  projectId: idSchema,
  slug: z.string(),
  kind: z.enum(['missing-brief', 'unresolved-questions', 'open-risks', 'brain-gaps']),
  severity: riskSeveritySchema,
  detail: z.string(),
});

export const systemAuditResultSchema = z.object({
  findings: z.array(systemAuditFindingSchema),
  recorded: z.number().int().nonnegative(),
});

/** Compression result (ADR-0033): the child continues; the parent is archived. */
export const compressResultSchema = z.object({
  childConversationId: idSchema,
  summary: z.string().min(1).max(4000),
  messageCount: z.number().int().positive(),
});
export type CompressResultWire = z.infer<typeof compressResultSchema>;

/** Read-only, bounded project context probe (ADR-0034). Paths + counts only. */
export const projectGitContextSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().optional(),
  dirtyCount: z.number().int().nonnegative().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  lastCommit: z.string().optional(),
});
export type ProjectGitContext = z.infer<typeof projectGitContextSchema>;

export const projectFilesContextSchema = z.object({
  totalFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  topDirs: z.array(z.object({ name: z.string(), files: z.number().int().nonnegative() })).max(40),
});
export type ProjectFilesContext = z.infer<typeof projectFilesContextSchema>;

export const projectContextSchema = z.object({
  projectId: idSchema,
  /** False = no root configured — honest needs-setup, not an invented tree. */
  configured: z.boolean(),
  root: z.string().nullable(),
  exists: z.boolean(),
  git: projectGitContextSchema.nullable(),
  files: projectFilesContextSchema.nullable(),
});
export type ProjectContextWire = z.infer<typeof projectContextSchema>;

// ── the method → result contract map (full coverage; see ADR-0032) ──────────

const sealedEventListSchema = z.array(sealedEventShellSchema);

/**
 * Result schema for every RPC method. The daemon's dispatch parses through this
 * on the way out; `@amrita/daemon`'s wire-contract test asserts the map and the
 * METHODS registry cover each other exactly.
 *
 * Cinema verbs are the one sanctioned opacity: the module daemon is their
 * payload authority (AGENTS.md), so they pass through as `unknown`.
 */
export const rpcResultSchemas: Readonly<Record<string, z.ZodType>> = {
  ping: z.object({ pong: z.literal(true) }),
  health: kernelHealthSchema,
  doctor: doctorReportSchema,

  'project.ensure': projectRowSchema,
  'project.get': projectRowSchema.nullable(),
  'project.list': z.array(projectRowSchema),

  'conversation.create': conversationRowSchema,
  'conversation.tree': z.array(conversationNodeSchema),
  'conversation.get': conversationNodeSchema.nullable(),
  'conversation.list': z.array(conversationNodeSchema),
  'conversation.compress': compressResultSchema,
  'conversation.archive': okTrueSchema,
  'lanes.workspace.ticket': z.object({ ticket: z.string(), expiresAt: z.string() }),
  'project.delete': z.object({ deleted: z.literal(true) }),

  'message.user.record': z.object({ messageId: idSchema, event: sealedEventShellSchema }),
  'events.list': sealedEventListSchema,

  'tasks.create': z.object({ taskId: idSchema }),
  'tasks.list': z.array(taskRowSchema),
  'tasks.complete': okTrueSchema,

  'projects.companion.get': companionStateSchema,
  'projects.brief.update': okTrueSchema,
  'projects.brand.update': okTrueSchema,
  'projects.previews.approve': okTrueSchema,
  'projects.questions.open': z.object({ questionId: idSchema }),
  'projects.questions.resolve': okTrueSchema,
  'projects.questions.drop': okTrueSchema,
  'projects.risks.open': z.object({ riskId: idSchema }),
  'projects.risks.resolve': okTrueSchema,
  'projects.risks.drop': okTrueSchema,
  'projects.milestones.create': z.object({ milestoneId: idSchema }),
  'projects.milestones.update': okTrueSchema,
  'projects.milestones.complete': okTrueSchema,
  'projects.timeline.list': sealedEventListSchema,

  'decisions.record': z.object({ decisionId: idSchema }),
  'decisions.list': z.array(decisionRowSchema),

  'memory.put': z.object({ entryId: idSchema }),
  'memory.search': z.array(memoryEntryRowSchema),

  'settings.update': okTrueSchema,
  'settings.get': z.object({ value: z.unknown() }),

  'accounts.connect': z.object({ accountId: idSchema }),
  'accounts.list': z.array(accountRowSchema),
  'accounts.bindSecretRef': okTrueSchema,
  'accounts.configStatus': z.object({ status: providerConfigStatusSchema.nullable() }),

  'connectors.list': z.array(connectorRowSchema),
  'connectors.status': z.array(connectorStatusReportSchema),

  'github.importIssues': githubImportResultSchema,

  'lanes.list': z.array(laneRowSchema),
  'lanes.start': laneStartResultSchema,
  'lanes.get': laneRowSchema.nullable(),
  'lanes.cancel': laneCancelResultSchema,

  'approvals.list': z.array(pendingApprovalSchema),
  'approvals.resolve': z.object({ approvalId: idSchema, resolved: z.boolean() }),

  'chat.turn': chatTurnResultSchema,

  'runtime.status': runtimeStatusSchema,
  'providers.role.set': okTrueSchema,
  'providers.role.clear': okTrueSchema,
  'providers.roles': z.object({ roles: z.array(roleResolutionSchema) }),
  'providers.list': z.array(providerInfoSchema),
  'providers.catalog': z.array(providerCatalogEntrySchema),
  'providers.models': modelDiscoveryResultSchema,
  'providers.probeEndpoint': probeEndpointResultSchema,

  'harness.topology': harnessTopologySchema,
  'harness.sources': z.array(knowledgeSourceSchema),
  'harness.brain': projectBrainSchema,
  'harness.capture': z.object({ entryId: idSchema, kind: z.string() }),

  'projects.context': projectContextSchema,
  'skills.list': z.array(skillStatusSchema),

  'operator.command': z.object({ reply: z.string() }),

  'system.health': systemHealthResultSchema,
  'system.audit': systemAuditResultSchema,
  'system.plan': z.object({ entryId: idSchema, kind: z.string() }),
  'system.manage': laneStartResultSchema,

  'channels.list': z.array(channelStatusEntrySchema),
  'channels.pairing.create': pairingRowSchema,
  'channels.pairing.list': z.array(pairingRowSchema),

  // Module-owned payloads (thin authenticated proxy — ADR-0028/AGENTS.md).
  'cinema.chat': z.unknown(),
  'cinema.assetAnalysis': z.unknown(),
  'cinema.providers': z.unknown(),

  'cinema.mandate.issue': z.object({ mandateId: idSchema }),
  'cinema.mandate.list': z.array(cinemaMandateRowSchema),
  'cinema.mandate.complete': z.union([
    okTrueSchema,
    z.object({ ok: z.literal(false), reason: z.enum(['not-found', 'already-resolved']) }),
  ]),
};

/** The stable, protocol-owned list of RPC method names. */
export const RPC_METHOD_NAMES: readonly string[] = Object.keys(rpcResultSchemas);

/**
 * Parse (and strip) one method's result against its wire contract. Methods
 * without a schema throw — coverage is total by construction.
 */
export function parseRpcResult(method: string, result: unknown): unknown {
  const schema = rpcResultSchemas[method];
  if (!schema) throw new Error(`no result contract for RPC method: ${method}`);
  return schema.parse(result);
}
