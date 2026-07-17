import {
  PROVIDER_ROLES,
  RPC_ERROR_CODES,
  type RoleResolution,
  type RpcErrorCode,
  type RpcId,
  acceptanceCriterionSchema,
  approvalDecisionSchema,
  approvalPolicySchema,
  authModeSchema,
  certaintySchema,
  chatFocusSchema,
  cinemaPlanRiskSchema,
  decisionRightSchema,
  derivationSchema,
  eventChannelSchema,
  eventOriginSchema,
  idSchema,
  inboxConfidenceSchema,
  inboxKindSchema,
  inboxOriginSchema,
  inboxStatusSchema,
  laneRoleSchema,
  laneRowStatusSchema,
  memoryScopeSchema,
  milestoneStatusSchema,
  networkPolicySchema,
  parseRpcResult,
  projectConstraintSchema,
  providerRoleSchema,
  riskSeveritySchema,
  taskPrioritySchema,
  taskStatusSchema,
} from '@amrita/protocol';
import { z } from 'zod';
import { cinemaProviders, runCinemaVerb } from './cinema.ts';
import { runDoctor } from './doctor.ts';
import { GithubError } from './github.ts';
import type { AmritaKernel } from './kernel.ts';
import { runOperatorCommand } from './operator.ts';
import { ProviderError } from './provider.ts';
import { systemAudit, systemHealth, systemManage, systemPlan } from './system.ts';
import { clean } from './util.ts';

/**
 * A small, typed, JSON-RPC-ish control layer for `amritad`. Requests and params
 * are validated with zod; RESULTS are parsed through the protocol's
 * `rpcResultSchemas` on the way out (ADR-0032), so nothing undeclared leaves
 * the daemon. Errors are structured `{ code, message, details? }` and never
 * carry a stack trace or a secret value. No method here calls a model provider
 * or runs a tool.
 */

export type { RpcErrorCode, RpcId };
export { RPC_ERROR_CODES };

export interface RpcSuccess {
  id: RpcId;
  result: unknown;
}
export interface RpcErrorResponse {
  id: RpcId;
  error: { code: RpcErrorCode; message: string; details?: unknown };
}
export type RpcResponse = RpcSuccess | RpcError;
export type RpcError = RpcErrorResponse;

// Unknown keys (e.g. a client's `jsonrpc: "2.0"`) are stripped, not rejected.
const requestSchema = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

function ok(id: RpcId, result: unknown): RpcSuccess {
  return { id, result };
}
function err(id: RpcId, code: RpcErrorCode, message: string, details?: unknown): RpcErrorResponse {
  return details === undefined
    ? { id, error: { code, message } }
    : { id, error: { code, message, details } };
}

/** Project zod issues to a safe shape (path + message + code; never received values). */
function safeIssues(issues: z.ZodIssue[]): { path: string; message: string; code: string }[] {
  return issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code }));
}

interface RpcMethod {
  params: z.ZodTypeAny;
  run: (kernel: AmritaKernel, params: unknown) => unknown | Promise<unknown>;
}

function def<S extends z.ZodTypeAny>(
  params: S,
  handler: (kernel: AmritaKernel, params: z.infer<S>) => unknown | Promise<unknown>,
): RpcMethod {
  // dispatch validates `params` against this schema before calling `run`,
  // so the cast is sound.
  return { params, run: (kernel, raw) => handler(kernel, raw as z.infer<S>) };
}

// Shared param fragments — enums come from the protocol (ADR-0032, no inline copies).
const writeOpts = { origin: eventOriginSchema.optional() };
const convCtx = { projectId: z.string(), conversationId: z.string() };
/** `YYYY-MM-DD` — mirrors the store's GLOB CHECK on every date column. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The role-resolution projection shared by `runtime.status` + `providers.roles`. */
function buildRoleResolutions(k: AmritaKernel, projectId?: string): RoleResolution[] {
  return PROVIDER_ROLES.map((role) => {
    const globalBinding = k.getRoleBinding(role) ?? null;
    const projectBinding = projectId ? (k.getRoleBinding(role, projectId) ?? null) : null;
    const resolved = k.resolveRole(role, projectId);
    return {
      role,
      binding: globalBinding,
      projectBinding,
      resolvesTo: resolved.provider,
      ...(resolved.model ? { model: resolved.model } : {}),
      via: resolved.via,
    };
  });
}

export const METHODS: Record<string, RpcMethod> = {
  ping: def(z.object({}).optional(), () => ({ pong: true })),

  health: def(z.object({}).optional(), (k) => k.health()),

  doctor: def(z.object({}).optional(), (k) => runDoctor(k)),

  'project.ensure': def(
    z.object({ slug: z.string().min(1), name: z.string().min(1), root: z.string().optional() }),
    (k, p) => k.ensureProject(clean(p)),
  ),
  'project.get': def(
    z.object({ id: z.string().optional(), slug: z.string().optional() }),
    (k, p) => k.getProject(clean(p)) ?? null,
  ),
  'project.list': def(z.object({}).optional(), (k) => k.listProjects()),

  'conversation.create': def(
    z.object({
      projectId: z.string(),
      title: z.string().optional(),
      parentId: z.string().optional(),
    }),
    (k, p) => k.createConversation(clean(p)),
  ),
  'conversation.tree': def(z.object({ conversationId: z.string() }), (k, p) =>
    k.getConversationTree(p.conversationId),
  ),
  'conversation.get': def(
    z.object({ conversationId: z.string() }),
    (k, p) => k.getConversation(p.conversationId) ?? null,
  ),
  'conversation.list': def(z.object({ projectId: z.string() }), (k, p) =>
    k.listConversations(p.projectId),
  ),
  // Compression-as-lineage (ADR-0033).
  'conversation.compress': def(z.object({ conversationId: z.string() }), (k, p) =>
    k.compressConversation(p.conversationId),
  ),
  // Session archive + project delete (ADR-0038).
  'conversation.archive': def(z.object({ conversationId: z.string() }), (k, p) =>
    k.archiveConversation(p.conversationId),
  ),
  'project.delete': def(z.object({ projectId: z.string() }), (k, p) =>
    k.deleteProject(p.projectId),
  ),

  'message.user.record': def(
    z.object({
      ...convCtx,
      text: z.string().min(1),
      channel: eventChannelSchema.optional(),
    }),
    (k, p) => k.recordUserMessage(clean(p)),
  ),

  'events.list': def(
    z.object({ conversationId: z.string(), sinceSeq: z.number().int().nonnegative().optional() }),
    (k, p) => k.listEvents(p.conversationId, p.sinceSeq),
  ),

  'tasks.create': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      title: z.string().min(1),
      status: taskStatusSchema.optional(),
      milestoneId: z.string().optional(),
      body: z.string().max(4000).optional(),
      // ADR-0044: the column, the event and the store always supported these;
      // the wire dropped them.
      laneId: z.string().optional(),
      owner: z.string().min(1).max(120).optional(),
      dueDate: isoDate.optional(),
      priority: taskPrioritySchema.optional(),
      orderKey: z.string().min(1).max(64).optional(),
      blockedReason: z.string().min(1).max(300).optional(),
      certainty: certaintySchema.optional(), // ADR-0045
      phaseId: z.string().optional(), // ADR-0045
      derivedFrom: z.array(derivationSchema).max(6).optional(), // ADR-0045 — why it exists
    }),
    (k, p) => k.createTask(clean(p)),
  ),
  /**
   * ADR-0044: the missing wire. `store.updateTask` has been implemented and
   * tested since ADR-0018 with ZERO callers above the store — this is what makes
   * a board drag expressible at all.
   *
   * `.nullable()` on the clearable fields is load-bearing: absent = leave alone,
   * null = clear. `clean()` strips undefined but preserves null.
   */
  'tasks.update': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      taskId: z.string(),
      status: taskStatusSchema.optional(),
      title: z.string().min(1).optional(),
      body: z.string().max(4000).optional(),
      milestoneId: z.string().nullable().optional(),
      owner: z.string().min(1).max(120).nullable().optional(),
      dueDate: isoDate.nullable().optional(),
      priority: taskPrioritySchema.nullable().optional(),
      orderKey: z.string().min(1).max(64).optional(),
      blockedReason: z.string().min(1).max(300).nullable().optional(),
      certainty: certaintySchema.nullable().optional(),
      phaseId: z.string().nullable().optional(), // ADR-0045 — null unlinks
      derivedFrom: z.array(derivationSchema).max(6).optional(),
      // ADR-0055: typed acceptance criteria (empty array clears). Verification
      // itself has its own gated method — never writable directly over RPC.
      acceptance: z.array(acceptanceCriterionSchema).max(20).optional(),
      /** ADR-0045: WHY. "אירוע שמספר מי הזיז, מאיזה מצב לאיזה מצב, מתי ולמה." */
      reason: z.string().min(1).max(300).optional(),
      // ADR-0045: optimistic lock. Omit it and you opt out (CLI/agent); send it and
      // a stale write is REFUSED with `conflict` instead of silently overwriting.
      expectedVersion: z.number().int().nonnegative().optional(),
    }),
    (k, p) => k.updateTask(clean(p)),
  ),
  'tasks.list': def(
    z.object({
      projectId: z.string().optional(),
      conversationId: z.string().optional(),
      status: taskStatusSchema.optional(),
    }),
    (k, p) => k.listTasks(clean(p)),
  ),
  'tasks.complete': def(z.object({ ...convCtx, ...writeOpts, taskId: z.string() }), (k, p) =>
    k.completeTask(clean(p)),
  ),
  // ADR-0055: run the task's machine acceptance checks (commands are approval-
  // gated inside verifyTask; file checks are read-only in the project folder).
  'tasks.verify': def(z.object({ ...convCtx, ...writeOpts, taskId: z.string() }), (k, p) =>
    k.verifyTask(clean(p)),
  ),

  // ── project companion (ADR-0018) ──────────────────────────────────────────

  'projects.companion.get': def(z.object({ projectId: z.string() }), (k, p) =>
    k.getCompanion(p.projectId),
  ),
  'projects.brief.update': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      goal: z.string().min(1).max(2000),
      audience: z.string().min(1).max(500).optional(),
      successCriteria: z.array(z.string().min(1).max(500)).max(20).optional(),
      scope: z.array(z.string().min(1).max(500)).max(50).optional(),
      noScope: z.array(z.string().min(1).max(500)).max(50).optional(),
      // the charter (ADR-0044)
      finishLine: z.string().min(1).max(500).optional(),
      constraints: z.array(projectConstraintSchema).max(20).optional(),
      decisionRights: z.array(decisionRightSchema).max(20).optional(),
      certainty: z.record(z.string(), certaintySchema).optional(), // ADR-0045
      sourceMessageId: z.string().optional(),
      expectedVersion: z.number().int().nonnegative().optional(), // ADR-0045
    }),
    (k, p) => k.upsertBrief(clean(p)),
  ),
  'projects.brand.update': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      name: z.string().min(1).max(200).optional(),
      audience: z.string().min(1).max(500).optional(),
      tone: z.string().min(1).max(500).optional(),
      styleNotes: z.array(z.string().min(1).max(300)).max(20).optional(),
      palette: z.array(z.string().min(1).max(100)).max(12).optional(),
      typography: z.string().min(1).max(500).optional(),
      doNotUse: z.array(z.string().min(1).max(300)).max(20).optional(),
      sourceMessageId: z.string().optional(),
    }),
    (k, p) => k.upsertBrand(clean(p)),
  ),
  'projects.previews.approve': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      previewId: z.string().min(1).max(120),
      contentHash: z.string().min(1).max(64),
      sourceMessageId: z.string().optional(),
    }),
    (k, p) => k.approvePreview(clean(p)),
  ),
  'projects.questions.open': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      text: z.string().min(1).max(2000),
      sourceMessageId: z.string().optional(),
    }),
    (k, p) => k.openQuestion(clean(p)),
  ),
  'projects.questions.resolve': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      questionId: z.string(),
      resolution: z.string().min(1).max(2000).optional(),
      resolvedByDecisionId: z.string().optional(),
    }),
    (k, p) => k.resolveQuestion(clean(p)),
  ),
  'projects.questions.drop': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      questionId: z.string(),
      reason: z.string().min(1).max(2000),
    }),
    (k, p) => k.dropQuestion(clean(p)),
  ),
  'projects.risks.open': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      text: z.string().min(1).max(2000),
      severity: riskSeveritySchema.optional(),
      sourceMessageId: z.string().optional(),
    }),
    (k, p) => k.openRisk(clean(p)),
  ),
  'projects.risks.resolve': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      riskId: z.string(),
      resolution: z.string().min(1).max(2000).optional(),
      resolvedByDecisionId: z.string().optional(),
    }),
    (k, p) => k.resolveRisk(clean(p)),
  ),
  'projects.risks.drop': def(
    z.object({ ...convCtx, ...writeOpts, riskId: z.string(), reason: z.string().min(1).max(2000) }),
    (k, p) => k.dropRisk(clean(p)),
  ),
  'projects.milestones.create': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      title: z.string().min(1).max(300),
      description: z.string().min(1).max(2000).optional(),
      targetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      status: milestoneStatusSchema.optional(),
    }),
    (k, p) => k.createMilestone(clean(p)),
  ),
  'projects.milestones.update': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      milestoneId: z.string(),
      title: z.string().min(1).max(300).optional(),
      description: z.string().min(1).max(2000).optional(),
      status: milestoneStatusSchema.optional(),
      targetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
    }),
    (k, p) => k.updateMilestone(clean(p)), // clean() keeps null (targetDate unset = null)
  ),
  'projects.milestones.complete': def(
    z.object({ ...convCtx, ...writeOpts, milestoneId: z.string() }),
    (k, p) => k.completeMilestone(clean(p)),
  ),
  'projects.timeline.list': def(
    z.object({ projectId: z.string(), limit: z.number().int().positive().max(500).optional() }),
    (k, p) => k.listProjectEvents(p.projectId, p.limit),
  ),
  // ADR-0045: the computed critique — what is missing, unconfirmed or contradictory.
  'projects.charter.status': def(z.object({ projectId: z.string() }), (k, p) =>
    k.getCharterStatus(p.projectId),
  ),

  // ── phases + activation (ADR-0045) ────────────────────────────────────────
  'projects.phases.list': def(z.object({ projectId: z.string() }), (k, p) =>
    k.listPhases(p.projectId),
  ),
  /**
   * ADR-0045: bind the project's working folder. The BROWSER never picks a path —
   * the daemon validates it against the allowed-roots allowlist it was started with.
   */
  'projects.setRoot': def(
    z.object({ ...convCtx, ...writeOpts, root: z.string().min(1).max(500).nullable() }),
    (k, p) => k.setProjectRoot(clean(p)),
  ),
  /** What can actually be done with this task right now (derived, never stored). */
  'tasks.route': def(z.object({ taskId: z.string() }), (k, p) => k.routeForTask(p.taskId)),
  // ── the public hub (ADR-0045) ─────────────────────────────────────────────
  /** Preview the PUBLIC view. Reading it publishes nothing. */
  'projects.hub.preview': def(z.object({ projectId: z.string() }), (k, p) =>
    k.previewHub(p.projectId),
  ),
  /** Publish — approval-gated, and effectively irreversible. */
  'projects.hub.publish': def(z.object({ ...convCtx, ...writeOpts }), (k, p) =>
    k.publishHub(clean(p)),
  ),
  'projects.hub.revoke': def(
    z.object({ ...convCtx, ...writeOpts, reason: z.string().min(1).max(300) }),
    (k, p) => k.revokeHub(clean(p)),
  ),

  // ── the retrospective (ADR-0045) ──────────────────────────────────────────
  /** What actually happened. Reading it changes nothing. */
  'projects.retro': def(z.object({ projectId: z.string() }), (k, p) => k.buildRetro(p.projectId)),
  /** Run it: summary into the project, lessons offered as candidates. */
  'projects.retro.run': def(z.object({ ...convCtx, ...writeOpts }), (k, p) => k.runRetro(clean(p))),
  /**
   * Promote ONE lesson into organizational memory. The only path by which anything
   * crosses out of a project — and it is one lesson at a time, by hand. There is
   * deliberately no "promote all".
   */
  'projects.retro.promote': def(
    z.object({ ...convCtx, ...writeOpts, lesson: z.string().min(1).max(2000) }),
    (k, p) => k.promoteLesson(clean(p)),
  ),

  /** The weekly review packet (ADR-0045). Reading it changes nothing. */
  'projects.review': def(z.object({ projectId: z.string() }), (k, p) => k.buildReview(p.projectId)),
  /** Run the review now — it PROPOSES; it never changes the plan. */
  'projects.review.run': def(z.object({ projectId: z.string() }), (k, p) => ({
    raised: k.runProjectReview(p.projectId),
  })),
  /** Hand the task to a supervised lane — approval, budget and receipt all apply. */
  'tasks.delegate': def(z.object({ ...convCtx, ...writeOpts, taskId: z.string() }), (k, p) =>
    k.delegateTask(clean(p)),
  ),
  'projects.phases.create': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      title: z.string().min(1).max(120),
      description: z.string().max(1000).optional(),
      status: milestoneStatusSchema.optional(),
      orderKey: z.string().min(1).max(64).optional(),
    }),
    (k, p) => k.createPhase(clean(p)),
  ),
  'projects.phases.update': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      phaseId: z.string(),
      title: z.string().min(1).max(120).optional(),
      description: z.string().max(1000).nullable().optional(),
      status: milestoneStatusSchema.optional(),
      orderKey: z.string().min(1).max(64).optional(),
    }),
    (k, p) => k.updatePhase(clean(p)),
  ),
  /**
   * The operator APPROVES Amrita's proposal and the project becomes a plan.
   * Refused if the charter has no basis, and refused twice — a board is never
   * conjured out of nothing, and never behind your back.
   */
  'projects.activate': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      phases: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            description: z.string().max(1000).optional(),
          }),
        )
        .min(1)
        .max(12),
      milestones: z
        .array(z.object({ title: z.string().min(1).max(300), targetDate: isoDate.optional() }))
        .max(20)
        .optional(),
      tasks: z
        .array(
          z.object({
            title: z.string().min(1).max(300),
            phaseIndex: z.number().int().nonnegative().max(11).optional(),
          }),
        )
        .max(40)
        .optional(),
    }),
    (k, p) => k.activateProject(clean(p)),
  ),

  // ── the Inbox — the one triage queue (ADR-0044) ───────────────────────────
  'inbox.capture': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      origin: inboxOriginSchema.default('user'),
      text: z.string().min(1).max(2000),
      suggestedKind: inboxKindSchema.optional(),
      suggested: z.record(z.string(), z.unknown()).optional(),
      rationale: z.string().min(1).max(1000).optional(),
      confidence: inboxConfidenceSchema.optional(),
      sourceMessageId: z.string().optional(),
    }),
    (k, p) => k.captureInbox(clean(p)),
  ),
  'inbox.list': def(
    z.object({ projectId: z.string(), status: inboxStatusSchema.optional() }),
    (k, p) => k.listInbox(clean(p)),
  ),
  // The payload is validated per-kind on the way in, so a malformed proposal is
  // rejected as `invalid_params` and can never reach a domain command half-formed.
  'inbox.triage': def(
    z.intersection(
      z.object({ ...convCtx, ...writeOpts, itemId: z.string() }),
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('task'),
          title: z.string().min(1),
          body: z.string().max(4000).optional(),
          milestoneId: z.string().optional(),
        }),
        z.object({ kind: z.literal('decision'), text: z.string().min(1) }),
        z.object({
          kind: z.literal('risk'),
          text: z.string().min(1),
          severity: riskSeveritySchema.optional(),
        }),
        z.object({ kind: z.literal('question'), text: z.string().min(1) }),
        z.object({
          kind: z.literal('milestone'),
          title: z.string().min(1),
          description: z.string().optional(),
          targetDate: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        }),
        z.object({ kind: z.literal('memory'), content: z.string().min(1).max(4000) }),
      ]),
    ),
    (k, p) => k.triageInbox(clean(p)),
  ),
  'inbox.dismiss': def(
    z.object({ ...convCtx, ...writeOpts, itemId: z.string(), reason: z.string().min(1).max(500) }),
    (k, p) => k.dismissInbox(clean(p)),
  ),

  'decisions.record': def(z.object({ ...convCtx, ...writeOpts, text: z.string().min(1) }), (k, p) =>
    k.recordDecision(clean(p)),
  ),
  'decisions.list': def(
    z.object({
      projectId: z.string().optional(),
      conversationId: z.string().optional(),
      includeSuperseded: z.boolean().optional(),
    }),
    (k, p) => k.listDecisions(clean(p)),
  ),

  'memory.put': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      scope: memoryScopeSchema,
      content: z.string().min(1).max(4000),
      entryId: z.string().optional(),
      source: z.string().optional(),
    }),
    (k, p) => k.putMemoryEntry(clean(p)),
  ),
  'memory.search': def(
    z.object({
      query: z.string(),
      scope: memoryScopeSchema.optional(),
      projectId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    (k, p) => k.searchMemory(p.query, clean(p)),
  ),

  'settings.update': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      // Reserve internal control namespaces from untrusted writes. `cascade.*` in
      // particular is the switch that opens the decisions append-only DELETE guard
      // (migration 0008) — it must only ever be set by the store's own
      // deleteProject transaction, never by an RPC caller.
      key: z
        .string()
        .min(1)
        .refine((s) => !s.startsWith('cascade.'), {
          message: 'that settings key is reserved for internal use',
        }),
      value: z.unknown(),
    }),
    (k, p) => k.updateSetting(clean(p)),
  ),
  'settings.get': def(z.object({ key: z.string().min(1) }), (k, p) => ({
    value: k.getSetting(p.key),
  })),

  'accounts.connect': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      provider: z.string().min(1),
      authMode: authModeSchema,
      label: z.string().min(1).max(200).optional(),
    }),
    (k, p) => k.connectProviderAccount(clean(p)),
  ),
  'accounts.list': def(z.object({}).optional(), (k) => k.listAccounts()),
  'accounts.bindSecretRef': def(z.object({ accountId: z.string(), envName: z.string() }), (k, p) =>
    k.bindAccountSecretRef(p.accountId, p.envName),
  ),
  'accounts.configStatus': def(z.object({ accountId: z.string() }), (k, p) => ({
    status: k.getProviderConfigStatus(p.accountId),
  })),

  'connectors.list': def(z.object({}).optional(), (k) => k.listConnectors()),
  // live, probe-backed states for code-registered connector manifests (ADR-0022)
  'connectors.status': def(z.object({}).optional(), (k) => k.connectorStatus()),

  // ── GitHub import (ADR-0022, one-way) ─────────────────────────────────────
  'github.importIssues': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      channel: eventChannelSchema.optional(),
      repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/repo'),
      state: z.enum(['open', 'all']).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    (k, p) => k.importGithubIssues(clean(p)),
  ),

  'lanes.list': def(
    z.object({
      projectId: z.string().optional(),
      conversationId: z.string().optional(),
      status: laneRowStatusSchema.optional(),
      groupId: z.string().optional(),
      verifiesLaneId: z.string().optional(),
    }),
    (k, p) => k.listLanes(clean(p)),
  ),
  'lanes.start': def(
    z.object({
      conversationId: z.string(),
      goal: z.string().min(1).max(4000),
      kind: z.string().optional(),
      dryRun: z.boolean().optional(),
      real: z.boolean().optional(),
      detach: z.boolean().optional(),
      // ADR-0054 operator console: run in the project's bound working folder
      // and/or keep the goal as a label (nothing auto-typed into the pane).
      workspace: z.enum(['project', 'isolated']).optional(),
      sendGoal: z.boolean().optional(),
      idempotencyKey: z.string().min(1).max(200).optional(),
      // ADR-0049 correlation: parallel/compare groups and QA→build verification.
      // These are lane IDs (ULIDs) — match the `lane.spawned` constitution exactly
      // so a malformed value is rejected here, at the edge, not deep inside the
      // append transaction after a workspace dir was already created.
      groupId: idSchema.optional(),
      role: laneRoleSchema.optional(),
      verifiesLaneId: idSchema.optional(),
      scope: z
        .object({
          paths: z.array(z.string()).optional(),
          repos: z.array(z.string()).optional(),
          network: networkPolicySchema.optional(),
        })
        .optional(),
      budget: z
        .object({
          maxTurns: z.number().int().positive().optional(),
          maxTokens: z.number().int().positive().optional(),
          maxUsd: z.number().positive().optional(),
          maxMinutes: z.number().positive().optional(),
        })
        .optional(),
      contextPack: z
        .object({
          memory: z.array(z.string()).optional(),
          files: z.array(z.string()).optional(),
          decisions: z.array(z.string()).optional(),
        })
        .optional(),
      approvals: approvalPolicySchema.optional(),
      deliverables: z.array(z.string()).optional(),
    }),
    (k, p) => k.startLane(clean(p)),
  ),
  'lanes.get': def(z.object({ laneId: z.string() }), (k, p) => k.getLane(p.laneId) ?? null),

  // ── the Conclusion Capsule (ADR-0048): a derived, read-only view — what Amrita
  //    shows the operator instead of code and logs. Never a write path.
  'orchestration.capsule': def(z.object({ conversationId: z.string() }), (k, p) =>
    k.getConclusionCapsule(p.conversationId),
  ),

  // ── operator approvals (ADR-0021) ─────────────────────────────────────────
  'approvals.list': def(z.object({}).optional(), (k) => k.listPendingApprovals()),
  'approvals.resolve': def(
    z.object({ approvalId: z.string(), decision: approvalDecisionSchema }),
    (k, p) => k.resolveApproval(p.approvalId, p.decision),
  ),
  'lanes.cancel': def(z.object({ laneId: z.string() }), (k, p) => k.cancelLane(p.laneId)),
  // Interactive tmux sessions (ADR-0049/0050): every control is project-scoped.
  'lanes.session.send': def(
    z.object({ projectId: z.string(), laneId: z.string(), text: z.string().min(1).max(4000) }),
    (k, p) => k.sendSessionInput(p.projectId, p.laneId, p.text),
  ),
  'lanes.session.finish': def(z.object({ projectId: z.string(), laneId: z.string() }), (k, p) =>
    k.finishSession(p.projectId, p.laneId),
  ),
  'lanes.session.cancel': def(z.object({ projectId: z.string(), laneId: z.string() }), (k, p) =>
    k.cancelSession(p.projectId, p.laneId),
  ),
  'lanes.session.snapshot': def(z.object({ projectId: z.string(), laneId: z.string() }), (k, p) =>
    k.getSessionSnapshot(p.projectId, p.laneId),
  ),
  // ADR-0039 amendment: lane-scoped read-only ticket for the canvas iframe —
  // the global bearer never enters a frame URL.
  'lanes.workspace.ticket': def(z.object({ laneId: z.string() }), (k, p) =>
    k.issueWorkspaceTicket(p.laneId),
  ),
  // ADR-0057: mint a single-use browser pairing code. Reaching this method at
  // all requires the bearer (or an already-paired session), so only the local
  // operator can open the door for a new browser.
  'auth.pair.mint': def(z.object({}).optional(), (k) => k.mintPairingCode()),
  // ADR-0057 finding 3: store a generated-HTML preview; the SPA loads the
  // returned ticket URL in a sandboxed, self-CSP'd iframe (never srcdoc).
  'artifact.preview.put': def(z.object({ html: z.string().min(1).max(262_144) }), (k, p) =>
    k.putArtifactPreview(p.html),
  ),

  'chat.turn': def(
    z.object({
      conversationId: z.string(),
      text: z.string().min(1),
      provider: z.string().optional(),
      model: z.string().optional(),
      role: providerRoleSchema.optional(),
      accountId: z.string().optional(),
      dryRun: z.boolean().optional(),
      channel: eventChannelSchema.optional(),
      // ADR-0045: what the operator is looking at, so the conversation is about
      // the thing on screen and they do not have to re-describe it.
      focus: chatFocusSchema.optional(),
    }),
    (k, p) => k.runChatTurn(clean(p)),
  ),
  // ── runtime selection (ADR-0019) ──────────────────────────────────────────

  /** One aggregate for the Settings & Runtime Hub: roles + providers + coding runtimes. */
  'runtime.status': def(
    z.object({ projectId: z.string().optional() }).optional(),
    async (k, p) => ({
      roles: buildRoleResolutions(k, p?.projectId),
      providers: k.listProviders(),
      codingRuntimes: await k.getCodingRuntimes(),
    }),
  ),
  'providers.role.set': def(
    z.object({
      role: providerRoleSchema,
      provider: z.string().min(1),
      model: z.string().min(1).optional(),
      projectId: z.string().optional(),
    }),
    (k, p) => k.setRoleBinding(clean(p)),
  ),
  'providers.role.clear': def(
    z.object({
      role: providerRoleSchema,
      projectId: z.string().optional(),
    }),
    (k, p) => k.clearRoleBinding(clean(p)),
  ),

  'providers.roles': def(z.object({ projectId: z.string().optional() }).optional(), (k, p) => ({
    roles: buildRoleResolutions(k, p?.projectId),
  })),
  'providers.list': def(z.object({}).optional(), (k) => k.listProviders()),
  // The chooser-UI catalog (ADR-0025): live bounded CLI probes, honest states.
  'providers.catalog': def(z.object({}).optional(), (k) => k.providersCatalog()),
  // Live model discovery for a provider (ADR-0026): /models probe → curated fallback.
  'providers.models': def(z.object({ provider: z.string().min(1) }), (k, p) =>
    k.discoverModels(p.provider),
  ),
  // Probe an arbitrary OpenAI-compatible endpoint during setup (ADR-0026).
  'providers.probeEndpoint': def(
    z.object({ baseUrl: z.string().min(1), keyEnv: z.string().optional() }),
    (k, p) => k.probeEndpoint(p.baseUrl, p.keyEnv),
  ),

  // ── organizational brain harness (ADR-0027) ───────────────────────────────
  // The harness-as-code topology (honest active/planned agents).
  'harness.topology': def(z.object({}).optional(), (k) => k.harnessTopology()),
  // Ingestion sources with honest connected/manual/planned status.
  'harness.sources': def(z.object({ projectId: z.string().min(1).optional() }).optional(), (k, p) =>
    k.listKnowledgeSources(p?.projectId),
  ),
  // The maintained Project Brain: normalized records + links + gaps + maintenance.
  'harness.brain': def(z.object({ projectId: z.string().min(1) }), (k, p) =>
    k.getProjectBrain(p.projectId),
  ),
  // Manual capture (capture-agent): structured memory → normalized record.
  'harness.capture': def(
    z.object({
      ...convCtx,
      ...writeOpts,
      kind: z
        .enum([
          'decision',
          'commitment',
          'meeting-note',
          'project-context',
          'open-question',
          'entity',
          'source-excerpt',
        ])
        .optional(),
      title: z.string().min(1).max(300),
      body: z.string().max(4000).optional(),
      owner: z.string().min(1).max(80).optional(),
      date: z.string().min(1).max(40).optional(),
      tags: z.array(z.string().min(1).max(40)).max(12).optional(),
      source: z.string().min(1).max(120).optional(),
    }),
    (k, p) => k.captureKnowledge(clean(p)),
  ),

  // HARMONY-6: calendar ingestion by import (.ics paste/upload) — honest source.
  'harness.importIcs': def(
    z.object({ ...convCtx, ...writeOpts, ics: z.string().min(1).max(500_000) }),
    (k, p) => k.importIcs(clean(p)),
  ),

  // Read-only project context probe (ADR-0034).
  'projects.context': def(z.object({ projectId: z.string() }), (k, p) =>
    k.getProjectContext(p.projectId),
  ),

  // The skill registry (ADR-0035): register + gate, never execute.
  'skills.list': def(z.object({ projectId: z.string().optional() }).optional(), (k, p) =>
    k.listSkills(p?.projectId),
  ),

  // Terminal/remote parity (ADR-0037): the SAME kernel interpreter every
  // chat channel uses, exposed over RPC so `amrita op` answers identically.
  'operator.command': def(
    z.object({ projectId: z.string(), text: z.string().min(1).max(500) }),
    async (k, p) => ({ reply: await runOperatorCommand(k, p.text, p.projectId) }),
  ),

  // ── Global Amrita / System Brain (ADR-0036) ────────────────────────────────
  'system.health': def(z.object({}).optional(), (k) => systemHealth(k)),
  'system.audit': def(z.object({ record: z.boolean().optional() }).optional(), (k, p) =>
    systemAudit(k, clean(p ?? {})),
  ),
  'system.plan': def(
    z.object({
      projectId: z.string(),
      title: z.string().min(1).max(200),
      body: z.string().max(4000).optional(),
    }),
    (k, p) => systemPlan(k, clean(p)),
  ),
  'system.manage': def(
    z.object({
      projectId: z.string(),
      goal: z.string().min(1).max(4000),
      kind: z.string().optional(),
      dryRun: z.boolean().optional(),
    }),
    (k, p) => systemManage(k, clean(p)),
  ),

  // Honest readiness: `ready` only when the surface actually works end-to-end
  // from THIS daemon right now. Telegram is ready only while its runner is live.
  'channels.list': def(z.object({}).optional(), (k) => [
    {
      id: 'web',
      kind: 'web',
      ready: true,
      status: 'ready',
      note: 'served by this daemon (HTTP + WS, bearer-token gated)',
    },
    k.isChannelRunnerActive('telegram')
      ? {
          id: 'telegram',
          kind: 'telegram',
          ready: true,
          status: 'ready',
          note: 'operator runner live (owner-gated long poll)',
        }
      : {
          id: 'telegram',
          kind: 'telegram',
          ready: false,
          status: 'needs_setup',
          note: 'runner available — set TELEGRAM_BOT_TOKEN + AMRITA_TELEGRAM_ALLOWED_IDS, start amritad --telegram',
        },
    // WhatsApp (ADR-0037): adapter + contract tests exist; the live Cloud-API
    // webhook runner is not bundled yet — needs_setup states exactly that.
    {
      id: 'whatsapp',
      kind: 'whatsapp',
      ready: false,
      status: 'needs_setup',
      note: 'adapter ready; webhook runner not bundled yet — needs WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_VERIFY_TOKEN and an HTTPS webhook (next slice)',
    },
  ]),
  'channels.pairing.create': def(
    z.object({
      channel: z.enum(['web', 'telegram', 'whatsapp']).optional(),
      projectId: z.string(),
      conversationId: z.string().optional(),
    }),
    (k, p) => k.createPairing({ channel: p.channel ?? 'telegram', ...clean(p) }),
  ),
  'channels.pairing.list': def(
    z.object({ channel: z.enum(['web', 'telegram', 'whatsapp']).optional() }),
    (k, p) => k.listPairings(p.channel),
  ),

  // Cinema module verbs (ADR-0028, Phase 2) — amritad is the front door; the
  // module's own brain (brain-bridge cinema-agent.mjs) stays the single source,
  // reached by a thin authenticated proxy. Payloads are validated/normalized by
  // the module daemon itself; here we only bound the envelope.
  'cinema.chat': def(z.object({ body: z.record(z.string(), z.unknown()).default({}) }), (_k, p) =>
    runCinemaVerb('chat', p.body),
  ),
  'cinema.assetAnalysis': def(
    z.object({ body: z.record(z.string(), z.unknown()).default({}) }),
    (_k, p) => runCinemaVerb('assetAnalysis', p.body),
  ),
  // Honest provider rows for the Cinema module (Phase 5): computed by the
  // module bridge's /health, only RENDERED here — no probe, no green.
  'cinema.providers': def(z.object({}).optional(), () => cinemaProviders()),

  // Cinema mandates (ADR-0029): Amrita delegates a goal; the module executes
  // under its own trust ladder and reports back. Open/resolved is a derived
  // projection over the conversation's events — no new table.
  'cinema.mandate.issue': def(
    z.object({
      projectId: z.string(),
      conversationId: z.string(),
      goal: z.string().min(1).max(2000),
      allowedVerbs: z.array(z.string().min(1)).max(32).optional(),
      maxRisk: cinemaPlanRiskSchema.optional(),
      note: z.string().max(500).optional(),
    }),
    (k, p) => k.issueCinemaMandate(clean(p)),
  ),
  'cinema.mandate.list': def(
    z.object({ conversationId: z.string(), openOnly: z.boolean().optional() }),
    (k, p) => k.listCinemaMandates(p.conversationId, p.openOnly ?? false),
  ),
  'cinema.mandate.complete': def(
    z.object({ projectId: z.string(), conversationId: z.string(), report: z.unknown() }),
    (k, p) => k.completeCinemaMandate(p),
  ),
};

/** The stable list of supported method names. */
export const METHOD_NAMES: readonly string[] = Object.keys(METHODS);

function classify(message: string): RpcErrorCode {
  if (/no such|not found/i.test(message)) return 'not_found';
  if (/not a safe env-var|refusing to bind/i.test(message)) return 'invalid_params';
  if (/^conflict:/i.test(message)) return 'conflict';
  return 'internal';
}

/** Validate + dispatch one request against the kernel. Always resolves to a response. */
export async function dispatch(kernel: AmritaKernel, raw: unknown): Promise<RpcResponse> {
  const idGuess: RpcId =
    raw && typeof raw === 'object' && 'id' in raw ? ((raw as { id?: RpcId }).id ?? null) : null;

  const req = requestSchema.safeParse(raw);
  if (!req.success) {
    return err(idGuess, 'invalid_request', 'malformed request', safeIssues(req.error.issues));
  }
  const id = req.data.id ?? null;
  const m = METHODS[req.data.method];
  if (!m) return err(id, 'unknown_method', `unknown method: ${req.data.method}`);

  const params = m.params.safeParse(req.data.params ?? {});
  if (!params.success) {
    return err(
      id,
      'invalid_params',
      `invalid params for ${req.data.method}`,
      safeIssues(params.error.issues),
    );
  }

  try {
    const raw = await m.run(kernel, params.data);
    // ADR-0032: parse (and STRIP) the result against the protocol's wire
    // contract before it leaves the daemon. A mismatch here is a daemon bug —
    // reported value-free as `internal`, never as the caller's fault.
    let result: unknown;
    try {
      result = parseRpcResult(req.data.method, raw);
    } catch (contractErr) {
      const details =
        contractErr instanceof z.ZodError ? safeIssues(contractErr.issues) : undefined;
      return err(id, 'internal', `result contract violation for ${req.data.method}`, details);
    }
    return ok(id, result);
  } catch (e) {
    // Never leak a stack trace; map the message to a structured code.
    // A ZodError from a deeper boundary (e.g. the store's event parse, like the
    // companion resolve-needs-evidence refine) is still an input problem.
    if (e instanceof z.ZodError) {
      return err(id, 'invalid_params', 'invalid payload', safeIssues(e.issues));
    }
    if (e instanceof ProviderError) {
      const code = e.code === 'unknown_provider' ? 'invalid_params' : e.code;
      return err(id, code, e.message);
    }
    if (e instanceof GithubError) {
      const code: RpcErrorCode =
        e.code === 'needs_setup'
          ? 'missing_env_value'
          : e.code === 'not_found'
            ? 'not_found'
            : 'provider_error';
      return err(id, code, e.message);
    }
    const message = e instanceof Error ? e.message : String(e);
    return err(id, classify(message), message);
  }
}

export function isErrorResponse(r: RpcResponse): r is RpcError {
  return 'error' in r;
}
