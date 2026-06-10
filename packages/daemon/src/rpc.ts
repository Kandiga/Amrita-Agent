import { z } from 'zod';
import type { AmritaKernel } from './kernel.ts';
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
  run: (kernel: AmritaKernel, params: unknown) => unknown;
}

function def<S extends z.ZodTypeAny>(
  params: S,
  handler: (kernel: AmritaKernel, params: z.infer<S>) => unknown,
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
};

/** The stable list of supported method names. */
export const METHOD_NAMES: readonly string[] = Object.keys(METHODS);

function classify(message: string): RpcErrorCode {
  if (/no such|not found/i.test(message)) return 'not_found';
  if (/not a safe env-var|refusing to bind/i.test(message)) return 'invalid_params';
  return 'internal';
}

/** Validate + dispatch one request against the kernel. Always returns a response. */
export function dispatch(kernel: AmritaKernel, raw: unknown): RpcResponse {
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
    return ok(id, m.run(kernel, params.data));
  } catch (e) {
    // Never leak a stack trace; map the message to a structured code.
    const message = e instanceof Error ? e.message : String(e);
    return err(id, classify(message), message);
  }
}

export function isErrorResponse(r: RpcResponse): r is RpcError {
  return 'error' in r;
}
