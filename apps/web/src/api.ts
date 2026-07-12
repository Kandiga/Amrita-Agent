/**
 * The web app's only network layer: a typed JSON-RPC client over the amritad
 * HTTP surface (`POST /rpc`, `GET /events`). Since ADR-0032 every response is
 * parsed through `@amrita/protocol` — the RPC envelope, each method's result
 * contract, and replayed events — so nothing crosses the daemon→browser
 * boundary unvalidated. No secret ever appears in a request or a rendered
 * response (the daemon guarantees secret-free results).
 */

import {
  type ChatTurnResultWire,
  type CodingRuntimeStatusWire,
  type CompanionStateWire,
  type ConnectorStatusReport,
  type DecisionRowWire,
  type DoctorCheck,
  type DoctorReport,
  type HarnessTopology,
  type KnowledgeGap,
  type KnowledgeRecord,
  type KnowledgeSource,
  type LaneCancelResultWire,
  type LaneRowWire,
  type LaneStartResultWire,
  type MaintenanceEvent,
  type MemoryEntryRowWire,
  type MilestoneRowWire,
  type OpenQuestionRowWire,
  type PendingApprovalWire,
  type ProjectBrain,
  type ProjectBrandRowWire,
  type ProjectBriefRowWire,
  type ProviderCatalogEntryWire,
  type ProviderRole,
  type RiskRowWire,
  type RoleResolution,
  type RuntimeStatusWire,
  parseRpcResult,
  rpcResponseSchema,
  sealedEventShellSchema,
} from '@amrita/protocol';
import { z } from 'zod';

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

/**
 * The UI's event view — a structural projection of the protocol's
 * `SealedEventShell` (which is what actually arrives and is what the wire
 * parse validates). Kept loose (`type: string`) so panels can switch on event
 * kinds without importing the full event taxonomy.
 */
export interface AmritaEventLite {
  id: string;
  seq: number;
  ts: string;
  type: string;
  /** Envelope lane id (present on lane.* events; payload may omit it for progress). */
  laneId?: string | undefined;
  payload: Record<string, unknown>;
}

// ── wire types (protocol-owned since ADR-0032; aliased for existing panels) ──

export type LaneRowLite = LaneRowWire;
export type LaneStartResultLite = LaneStartResultWire;
export type LaneCancelResultLite = LaneCancelResultWire;
export type TaskRowLite = {
  id: string;
  title: string;
  status: string;
  milestoneId?: string | null;
  createdAt?: string;
};
export type BriefLite = ProjectBriefRowWire;
export type QuestionLite = OpenQuestionRowWire;
export type RiskLite = RiskRowWire;
export type MilestoneLite = MilestoneRowWire;
export type BrandLite = ProjectBrandRowWire;
export type OperatorApprovalLite = PendingApprovalWire;
export type CompanionState = CompanionStateWire;
export type PreviewApprovalLite = CompanionStateWire['previewApprovals'][number];
export type DoctorCheckLite = DoctorCheck;
export type DoctorReportLite = DoctorReport;
export type RoleResolutionLite = RoleResolution;
export type CodingRuntimeLite = CodingRuntimeStatusWire;
export type ProviderCatalogEntryLite = ProviderCatalogEntryWire;
export type RuntimeStatusLite = RuntimeStatusWire;
export type DecisionRowLite = DecisionRowWire;
export type MemoryEntryLite = MemoryEntryRowWire;
export type ChatResult = ChatTurnResultWire;

// Harness views (ADR-0027) — protocol-owned schemas, aliased for the panels.
export type KnowledgeRecordLite = KnowledgeRecord;
export type KnowledgeSourceLite = KnowledgeSource;
export type KnowledgeGapLite = KnowledgeGap;
export type MaintenanceEventLite = MaintenanceEvent;
export type HarnessTopologyLite = HarnessTopology;
export type HarnessAgentLite = HarnessTopology['agents'][number];
export type ProjectBrainLite = ProjectBrain;

/** Live connector status (ADR-0022). `connected` only ever follows a real probe. */
export type ConnectorStatusLite = ConnectorStatusReport;

export interface GithubImportLite {
  repo: string;
  imported: number;
  skipped: number;
  total: number;
  tasks: { taskId: string; externalRef: string; title: string }[];
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

export interface BrandUpdateParams {
  projectId: string;
  conversationId: string;
  name?: string;
  audience?: string;
  tone?: string;
  styleNotes?: string[];
  palette?: string[];
  typography?: string;
  doNotUse?: string[];
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

const eventsReplySchema = z.object({ events: z.array(sealedEventShellSchema).default([]) });

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
    // ADR-0032: parse the envelope, then the method's result contract. The
    // remaining cast is validated — `T` mirrors the protocol type per wrapper.
    const body = rpcResponseSchema.parse(await res.json());
    if ('error' in body)
      throw new RpcError(body.error.code, body.error.message, body.error.details);
    return parseRpcResult(method, body.result) as T;
  }

  async events(conversationId: string, sinceSeq = 0): Promise<AmritaEventLite[]> {
    const url = `${this.baseUrl}/events?conversationId=${encodeURIComponent(conversationId)}&sinceSeq=${sinceSeq}`;
    const res = await this.fetchImpl(url, { headers: this.authHeaders() });
    if (res.status === 401 || res.status === 403) {
      throw new RpcError('unauthorized', 'authentication required');
    }
    return eventsReplySchema.parse(await res.json()).events;
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

  approvalsList(): Promise<OperatorApprovalLite[]> {
    return this.call<OperatorApprovalLite[]>('approvals.list');
  }

  approvalsResolve(params: {
    approvalId: string;
    decision: 'allow' | 'deny';
  }): Promise<{ approvalId: string; resolved: boolean }> {
    return this.call<{ approvalId: string; resolved: boolean }>('approvals.resolve', params);
  }

  brandUpdate(params: BrandUpdateParams): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.brand.update', params);
  }

  previewApprove(params: {
    projectId: string;
    conversationId: string;
    previewId: string;
    contentHash: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.previews.approve', params);
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

  // ── runtime selection (ADR-0019) ────────────────────────────────────────

  runtimeStatus(projectId?: string): Promise<RuntimeStatusLite> {
    return this.call<RuntimeStatusLite>('runtime.status', projectId ? { projectId } : {});
  }

  /**
   * The provider chooser catalog (ADR-0025/0026): same truth the CLI wizard and
   * `amrita provider catalog` render — live bounded probes, honest states.
   */
  providersCatalog(): Promise<ProviderCatalogEntryLite[]> {
    return this.call<ProviderCatalogEntryLite[]>('providers.catalog', {});
  }

  // ── organizational brain harness (ADR-0027) ─────────────────────────────

  harnessTopology(): Promise<HarnessTopologyLite> {
    return this.call<HarnessTopologyLite>('harness.topology', {});
  }

  harnessSources(): Promise<KnowledgeSourceLite[]> {
    return this.call<KnowledgeSourceLite[]>('harness.sources', {});
  }

  harnessBrain(projectId: string): Promise<ProjectBrainLite> {
    return this.call<ProjectBrainLite>('harness.brain', { projectId });
  }

  harnessCapture(params: {
    projectId: string;
    conversationId: string;
    kind?: KnowledgeRecordLite['kind'];
    title: string;
    body?: string;
    owner?: string;
    date?: string;
    tags?: string[];
    source?: string;
  }): Promise<{ entryId: string; kind: string }> {
    return this.call<{ entryId: string; kind: string }>('harness.capture', params);
  }

  // ── connectors + GitHub import (ADR-0022) ───────────────────────────────

  connectorsStatus(): Promise<ConnectorStatusLite[]> {
    return this.call<ConnectorStatusLite[]>('connectors.status');
  }

  githubImport(params: {
    projectId: string;
    conversationId: string;
    repo: string;
    state?: 'open' | 'all';
    limit?: number;
  }): Promise<GithubImportLite> {
    return this.call<GithubImportLite>('github.importIssues', { ...params, channel: 'web' });
  }

  roleSet(params: {
    role: ProviderRole;
    provider: string;
    model?: string;
    projectId?: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('providers.role.set', params);
  }

  roleClear(params: { role: ProviderRole; projectId?: string }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('providers.role.clear', params);
  }

  timelineList(projectId: string, limit?: number): Promise<AmritaEventLite[]> {
    return this.call<AmritaEventLite[]>('projects.timeline.list', {
      projectId,
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}
