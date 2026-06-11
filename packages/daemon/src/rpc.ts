import { z } from 'zod';
import { runDoctor } from './doctor.ts';
import type { AmritaKernel } from './kernel.ts';
import { ProviderError } from './provider.ts';
import { clean } from './util.ts';

/**
 * A small, typed, JSON-RPC-ish control layer for `amritad`. Requests and params
 * are validated with zod; errors are structured `{ code, message, details? }` and
 * never carry a stack trace or a secret value. Method names are stable (see
 * docs/specs/runtime.md). No method here calls a model provider or runs a tool.
 */

export type RpcId = string | number | null;

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
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

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

// Shared param fragments.
const writeOpts = { origin: z.enum(['user', 'agent', 'lane', 'system']).optional() };
const convCtx = { projectId: z.string(), conversationId: z.string() };

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

  'message.user.record': def(
    z.object({
      ...convCtx,
      text: z.string().min(1),
      channel: z.enum(['web', 'telegram', 'cli', 'api']).optional(),
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
      status: z.enum(['now', 'later', 'done', 'dropped']).optional(),
      milestoneId: z.string().optional(),
    }),
    (k, p) => k.createTask(clean(p)),
  ),
  'tasks.list': def(
    z.object({
      projectId: z.string().optional(),
      conversationId: z.string().optional(),
      status: z.enum(['now', 'later', 'done', 'dropped']).optional(),
    }),
    (k, p) => k.listTasks(clean(p)),
  ),
  'tasks.complete': def(z.object({ ...convCtx, ...writeOpts, taskId: z.string() }), (k, p) =>
    k.completeTask(clean(p)),
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
      sourceMessageId: z.string().optional(),
    }),
    (k, p) => k.upsertBrief(clean(p)),
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
      severity: z.enum(['low', 'medium', 'high']).optional(),
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
      status: z.enum(['planned', 'active', 'done', 'dropped']).optional(),
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
      status: z.enum(['planned', 'active', 'done', 'dropped']).optional(),
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
      scope: z.enum(['user', 'project']),
      content: z.string().min(1).max(4000),
      entryId: z.string().optional(),
      source: z.string().optional(),
    }),
    (k, p) => k.putMemoryEntry(clean(p)),
  ),
  'memory.search': def(
    z.object({
      query: z.string(),
      scope: z.enum(['user', 'project']).optional(),
      projectId: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
    (k, p) => k.searchMemory(p.query, clean(p)),
  ),

  'settings.update': def(
    z.object({ ...convCtx, ...writeOpts, key: z.string().min(1), value: z.unknown() }),
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
      authMode: z.enum(['api_key', 'subscription_cli', 'local_endpoint', 'oauth']),
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

  'lanes.list': def(
    z.object({
      projectId: z.string().optional(),
      conversationId: z.string().optional(),
      status: z.enum(['spawned', 'running', 'merging', 'completed', 'aborted']).optional(),
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
      scope: z
        .object({
          paths: z.array(z.string()).optional(),
          repos: z.array(z.string()).optional(),
          network: z.enum(['none', 'allowlist', 'open']).optional(),
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
      approvals: z.enum(['forward', 'auto-safe', 'sandboxed']).optional(),
      deliverables: z.array(z.string()).optional(),
    }),
    (k, p) => k.startLane(clean(p)),
  ),
  'lanes.get': def(z.object({ laneId: z.string() }), (k, p) => k.getLane(p.laneId) ?? null),
  'lanes.cancel': def(z.object({ laneId: z.string() }), (k, p) => k.cancelLane(p.laneId)),

  'chat.turn': def(
    z.object({
      conversationId: z.string(),
      text: z.string().min(1),
      provider: z.string().optional(),
      model: z.string().optional(),
      role: z.enum(['fast', 'main', 'deep']).optional(),
      accountId: z.string().optional(),
      dryRun: z.boolean().optional(),
      channel: z.enum(['web', 'telegram', 'cli', 'api']).optional(),
    }),
    (k, p) => k.runChatTurn(clean(p)),
  ),
  'providers.roles': def(z.object({}).optional(), (k) => ({
    roles: (['fast', 'main', 'deep'] as const).map((role) => {
      const binding = k.getRoleBinding(role);
      const resolved = k.resolveRole(role);
      return { role, binding: binding ?? null, resolvesTo: resolved.provider, via: resolved.via };
    }),
  })),
  'providers.list': def(z.object({}).optional(), (k) => k.listProviders()),

  // Honest readiness: `ready` only when the surface actually works end-to-end
  // from this daemon today. Telegram's transport is implemented and tested, but
  // no live bot runner ships yet — so it reports needs_setup, never "ready".
  'channels.list': def(z.object({}).optional(), () => [
    {
      id: 'web',
      kind: 'web',
      ready: true,
      status: 'ready',
      note: 'served by this daemon (HTTP + WS, bearer-token gated)',
    },
    {
      id: 'telegram',
      kind: 'telegram',
      ready: false,
      status: 'needs_setup',
      note: 'transport + owner allowlist tested; live bot runner not bundled yet',
    },
  ]),
  'channels.pairing.create': def(
    z.object({
      channel: z.enum(['web', 'telegram']).optional(),
      projectId: z.string(),
      conversationId: z.string().optional(),
    }),
    (k, p) => k.createPairing({ channel: p.channel ?? 'telegram', ...clean(p) }),
  ),
  'channels.pairing.list': def(
    z.object({ channel: z.enum(['web', 'telegram']).optional() }),
    (k, p) => k.listPairings(p.channel),
  ),
};

/** The stable list of supported method names. */
export const METHOD_NAMES: readonly string[] = Object.keys(METHODS);

function classify(message: string): RpcErrorCode {
  if (/no such|not found/i.test(message)) return 'not_found';
  if (/not a safe env-var|refusing to bind/i.test(message)) return 'invalid_params';
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
    return ok(id, await m.run(kernel, params.data));
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
    const message = e instanceof Error ? e.message : String(e);
    return err(id, classify(message), message);
  }
}

export function isErrorResponse(r: RpcResponse): r is RpcError {
  return 'error' in r;
}
