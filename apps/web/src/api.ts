/**
 * The web app's only network layer: a typed JSON-RPC client over the amritad
 * HTTP surface (`POST /rpc`, `GET /events`). No secret ever appears in a request
 * or a rendered response (the daemon guarantees secret-free results).
 */

export type FetchLike = typeof fetch;

export class RpcError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.details = details;
  }
}

export interface AmritaEventLite {
  id: string;
  seq: number;
  ts: string;
  type: string;
  /** Envelope lane id (present on lane.* events; payload may omit it for progress). */
  laneId?: string;
  payload: Record<string, unknown>;
}

export interface LaneRowLite {
  id: string;
  projectId: string;
  conversationId: string;
  kind: string;
  status: string;
  mandateJson: string;
  budgetJson?: string | null;
  mergeJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LaneBudgetInput {
  maxTurns?: number;
  maxMinutes?: number;
  maxTokens?: number;
  maxUsd?: number;
}

export interface LaneStartParams {
  conversationId: string;
  goal: string;
  kind?: string;
  dryRun?: boolean;
  real?: boolean;
  detach?: boolean;
  budget?: LaneBudgetInput;
}

export interface LaneStartResultLite {
  laneId: string;
  status: string;
  dryRun: boolean;
  detached: boolean;
  report: { exit: string; summary?: string } | null;
  error?: string;
}

export interface LaneCancelResultLite {
  laneId: string;
  cancelled: boolean;
  status: string | null;
}

export interface TaskRowLite {
  id: string;
  title: string;
  status: string;
  milestoneId?: string | null;
  createdAt?: string;
}

// ── project companion (ADR-0018) ─────────────────────────────────────────────

export interface BriefLite {
  projectId: string;
  goal: string;
  audience: string | null;
  successCriteria: string[];
  scope: string[];
  noScope: string[];
  updatedAt: string;
}

export interface QuestionLite {
  id: string;
  text: string;
  status: 'open' | 'resolved' | 'dropped';
  resolution: string | null;
  resolvedByDecisionId: string | null;
  dropReason: string | null;
  createdAt: string;
}

export interface RiskLite extends QuestionLite {
  severity: 'low' | 'medium' | 'high' | null;
}

export interface MilestoneLite {
  id: string;
  title: string;
  description: string | null;
  status: 'planned' | 'active' | 'done' | 'dropped';
  targetDate: string | null;
}

export interface CompanionState {
  brief: BriefLite | null;
  questions: QuestionLite[];
  risks: RiskLite[];
  milestones: MilestoneLite[];
}

// ── doctor (RPC result shapes; see docs/specs/runtime.md) ───────────────────

export interface DoctorCheckLite {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
}

export interface DoctorReportLite {
  ok: boolean;
  status: 'ok' | 'warn' | 'fail';
  sections: { title: string; checks: DoctorCheckLite[] }[];
  fixes: string[];
}

/** One role's resolution: project binding > global binding > auto (ADR-0017, §2.8). */
export interface RoleResolutionLite {
  role: 'fast' | 'main' | 'deep';
  binding: { provider: string; model?: string } | null;
  projectBinding: { provider: string; model?: string } | null;
  resolvesTo: string;
  model?: string;
  via: 'project' | 'binding' | 'auto';
}

export interface BriefUpdateParams {
  projectId: string;
  conversationId: string;
  goal: string;
  audience?: string;
  successCriteria?: string[];
  scope?: string[];
  noScope?: string[];
}

export interface DecisionRowLite {
  id: string;
  text: string;
  supersedesId?: string | null;
  createdAt?: string;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export interface RpcClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Local control-surface bearer token (never logged; sent as Authorization). */
  token?: string;
}

export class RpcClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private authToken: string | undefined;
  private nextId = 1;

  constructor(opts: RpcClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.authToken = opts.token || undefined;
  }

  /** Set/clear the bearer token used for subsequent calls (never logged). */
  setAuthToken(token: string | undefined): void {
    this.authToken = token || undefined;
  }

  hasAuthToken(): boolean {
    return this.authToken !== undefined;
  }

  private authHeaders(): Record<string, string> {
    return this.authToken ? { authorization: `Bearer ${this.authToken}` } : {};
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ id: this.nextId++, method, params }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new RpcError('unauthorized', 'authentication required');
    }
    const body = (await res.json()) as RpcEnvelope;
    if (body.error) throw new RpcError(body.error.code, body.error.message, body.error.details);
    return body.result as T;
  }

  async events(conversationId: string, sinceSeq = 0): Promise<AmritaEventLite[]> {
    const url = `${this.baseUrl}/events?conversationId=${encodeURIComponent(conversationId)}&sinceSeq=${sinceSeq}`;
    const res = await this.fetchImpl(url, { headers: this.authHeaders() });
    if (res.status === 401 || res.status === 403) {
      throw new RpcError('unauthorized', 'authentication required');
    }
    const body = (await res.json()) as { events?: AmritaEventLite[] };
    return body.events ?? [];
  }

  // ── lanes (typed wrappers; auth header is applied by call()) ────────────────

  lanesList(
    params: {
      projectId?: string;
      conversationId?: string;
      status?: string;
    } = {},
  ): Promise<LaneRowLite[]> {
    return this.call<LaneRowLite[]>('lanes.list', params);
  }

  lanesStart(params: LaneStartParams): Promise<LaneStartResultLite> {
    return this.call<LaneStartResultLite>('lanes.start', params);
  }

  lanesGet(laneId: string): Promise<LaneRowLite | null> {
    return this.call<LaneRowLite | null>('lanes.get', { laneId });
  }

  lanesCancel(laneId: string): Promise<LaneCancelResultLite> {
    return this.call<LaneCancelResultLite>('lanes.cancel', { laneId });
  }

  // ── project knowledge (typed wrappers; auth header is applied by call()) ───

  tasksCreate(params: {
    projectId: string;
    conversationId: string;
    title: string;
    milestoneId?: string;
  }): Promise<{ taskId: string }> {
    return this.call<{ taskId: string }>('tasks.create', params);
  }

  tasksComplete(params: {
    projectId: string;
    conversationId: string;
    taskId: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('tasks.complete', params);
  }

  decisionsList(params: { projectId?: string } = {}): Promise<DecisionRowLite[]> {
    return this.call<DecisionRowLite[]>('decisions.list', params);
  }

  decisionsRecord(params: {
    projectId: string;
    conversationId: string;
    text: string;
  }): Promise<{ decisionId: string }> {
    return this.call<{ decisionId: string }>('decisions.record', params);
  }

  memoryPut(params: {
    projectId: string;
    conversationId: string;
    scope: 'user' | 'project';
    content: string;
  }): Promise<{ entryId: string }> {
    return this.call<{ entryId: string }>('memory.put', params);
  }

  // ── project companion (ADR-0018) ────────────────────────────────────────

  companionGet(projectId: string): Promise<CompanionState> {
    return this.call<CompanionState>('projects.companion.get', { projectId });
  }

  briefUpdate(params: BriefUpdateParams): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.brief.update', params);
  }

  questionOpen(params: {
    projectId: string;
    conversationId: string;
    text: string;
  }): Promise<{ questionId: string }> {
    return this.call<{ questionId: string }>('projects.questions.open', params);
  }

  questionResolve(params: {
    projectId: string;
    conversationId: string;
    questionId: string;
    resolution?: string;
    resolvedByDecisionId?: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.questions.resolve', params);
  }

  questionDrop(params: {
    projectId: string;
    conversationId: string;
    questionId: string;
    reason: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.questions.drop', params);
  }

  riskOpen(params: {
    projectId: string;
    conversationId: string;
    text: string;
    severity?: 'low' | 'medium' | 'high';
  }): Promise<{ riskId: string }> {
    return this.call<{ riskId: string }>('projects.risks.open', params);
  }

  riskResolve(params: {
    projectId: string;
    conversationId: string;
    riskId: string;
    resolution?: string;
    resolvedByDecisionId?: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.risks.resolve', params);
  }

  riskDrop(params: {
    projectId: string;
    conversationId: string;
    riskId: string;
    reason: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.risks.drop', params);
  }

  milestoneCreate(params: {
    projectId: string;
    conversationId: string;
    title: string;
    targetDate?: string;
  }): Promise<{ milestoneId: string }> {
    return this.call<{ milestoneId: string }>('projects.milestones.create', params);
  }

  milestoneComplete(params: {
    projectId: string;
    conversationId: string;
    milestoneId: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.milestones.complete', params);
  }

  providersRoles(projectId?: string): Promise<{ roles: RoleResolutionLite[] }> {
    return this.call<{ roles: RoleResolutionLite[] }>(
      'providers.roles',
      projectId ? { projectId } : {},
    );
  }

  timelineList(projectId: string, limit?: number): Promise<AmritaEventLite[]> {
    return this.call<AmritaEventLite[]>('projects.timeline.list', {
      projectId,
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}
