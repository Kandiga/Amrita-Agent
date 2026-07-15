/**
 * The web app's only network layer: a typed JSON-RPC client over the amritad
 * HTTP surface (`POST /rpc`, `GET /events`). Since ADR-0032 every response is
 * parsed through `@amrita/protocol` — the RPC envelope, each method's result
 * contract, and replayed events — so nothing crosses the daemon→browser
 * boundary unvalidated. No secret ever appears in a request or a rendered
 * response (the daemon guarantees secret-free results).
 */

import {
  type AccountRowWire,
  type ChannelStatusEntryWire,
  type CharterStatusWire,
  type ChatFocus,
  type ChatTurnResultWire,
  type CinemaMandateRowWire,
  type CodingRuntimeStatusWire,
  type CompanionStateWire,
  type ConnectorStatusReport,
  type DecisionRight,
  type DecisionRowWire,
  type DoctorCheck,
  type DoctorReport,
  type HarnessTopology,
  type HubPreviewWire,
  type InboxItemRowWire,
  type InboxKind,
  type InboxStatus,
  type KnowledgeGap,
  type KnowledgeRecord,
  type KnowledgeSource,
  type LaneCancelResultWire,
  type LaneRowWire,
  type LaneStartResultWire,
  type MaintenanceEvent,
  type MemoryEntryRowWire,
  type MilestoneRowWire,
  type ModelDiscoveryResultWire,
  type OpenQuestionRowWire,
  type PairingRowWire,
  type PendingApprovalWire,
  type PhaseRowWire,
  type ProbeEndpointResultWire,
  type ProjectBrain,
  type ProjectBrandRowWire,
  type ProjectBriefRowWire,
  type ProjectConstraint,
  type ProjectContextWire,
  type ProviderCatalogEntryWire,
  type ProviderConfigStatus,
  type ProviderRole,
  type RetroPacketWire,
  type ReviewPacketWire,
  type RiskRowWire,
  type RoleResolution,
  type RouteVerdictWire,
  type RuntimeStatusWire,
  type SkillStatus,
  type SystemAuditResultWire,
  type SystemHealthResultWire,
  parseRpcResult,
  rpcResponseSchema,
  sealedEventShellSchema,
} from '@amrita/protocol';
import { z } from 'zod';
import type { TriageTarget } from './triage.ts';

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
export type ProjectContextLite = ProjectContextWire;
export type SkillStatusLite = SkillStatus;

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
  /** Mandate approval policy (R4 lane console): forward = operator-gated. */
  approvals?: 'forward' | 'auto-safe' | 'sandboxed';
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
  /** The charter (ADR-0044). Full-document upsert: omit these and they are CLEARED. */
  finishLine?: string;
  constraints?: ProjectConstraint[];
  decisionRights?: DecisionRight[];
  /** ADR-0045: a stale full-document write would WIPE the charter someone else wrote. */
  expectedVersion?: number;
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

  /** Open an interactive tmux session for an agent (ADR-0049). Gated by approval. */
  openSession(conversationId: string, kind: string, goal: string): Promise<LaneStartResultLite> {
    return this.call<LaneStartResultLite>('lanes.start', {
      conversationId,
      goal,
      kind,
      real: true,
      detach: true,
    });
  }

  sessionSend(laneId: string, text: string): Promise<{ laneId: string; sent: boolean }> {
    return this.call('lanes.session.send', { laneId, text });
  }

  sessionFinish(laneId: string): Promise<{ laneId: string; finished: boolean }> {
    return this.call('lanes.session.finish', { laneId });
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

  /**
   * ADR-0044: the board write path. `store.updateTask` existed and was tested
   * since ADR-0018 with zero callers — this is the client end of the missing wire.
   * For each field: omit = leave alone, `null` = clear.
   */
  tasksUpdate(params: {
    projectId: string;
    conversationId: string;
    taskId: string;
    status?: 'now' | 'later' | 'done' | 'dropped';
    title?: string;
    body?: string;
    milestoneId?: string | null;
    owner?: string | null;
    dueDate?: string | null;
    priority?: 'low' | 'normal' | 'high' | null;
    orderKey?: string;
    blockedReason?: string | null;
    /** ADR-0045: the row `version` this client last saw. Stale ⇒ `conflict`. */
    expectedVersion?: number;
    phaseId?: string | null;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('tasks.update', params);
  }

  tasksComplete(params: {
    projectId: string;
    conversationId: string;
    taskId: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('tasks.complete', params);
  }

  /**
   * The daemon has exposed `projects.milestones.update` since ADR-0018; the web
   * client never had a wrapper, so a milestone could never be set `active` from
   * the UI — which silently disabled the `milestone-plan` rule in companion.ts.
   */
  milestoneUpdate(params: {
    projectId: string;
    conversationId: string;
    milestoneId: string;
    title?: string;
    description?: string;
    status?: 'planned' | 'active' | 'done' | 'dropped';
    targetDate?: string | null;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.milestones.update', params);
  }

  // ── the Inbox — the one triage queue (ADR-0044) ────────────────────────────

  inboxList(params: { projectId: string; status?: InboxStatus }): Promise<InboxItemRowWire[]> {
    return this.call<InboxItemRowWire[]>('inbox.list', params);
  }

  inboxCapture(params: {
    projectId: string;
    conversationId: string;
    text: string;
  }): Promise<{ itemId: string }> {
    return this.call<{ itemId: string }>('inbox.capture', params);
  }

  /** Promote an item into a REAL aggregate. `target` is the typed command payload. */
  inboxTriage(
    params: { projectId: string; conversationId: string; itemId: string } & TriageTarget,
  ): Promise<{ promotedKind: InboxKind; promotedId: string }> {
    return this.call<{ promotedKind: InboxKind; promotedId: string }>('inbox.triage', params);
  }

  inboxDismiss(params: {
    projectId: string;
    conversationId: string;
    itemId: string;
    reason: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('inbox.dismiss', params);
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

  /** ADR-0045: the computed critique — missing / unconfirmed / contradictory. */
  charterStatus(projectId: string): Promise<CharterStatusWire> {
    return this.call<CharterStatusWire>('projects.charter.status', { projectId });
  }

  /** The project's own phases — where the board's columns come from (ADR-0045). */
  phasesList(projectId: string): Promise<PhaseRowWire[]> {
    return this.call<PhaseRowWire[]>('projects.phases.list', { projectId });
  }

  /**
   * Bind the project's working folder (ADR-0045). The browser NEVER picks a path —
   * it sends one, and the daemon validates it against its allowed-roots allowlist.
   */
  setProjectRoot(params: {
    projectId: string;
    conversationId: string;
    root: string | null;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.setRoot', params);
  }

  /** What can actually be done with this task right now (derived, never stored). */
  taskRoute(taskId: string): Promise<RouteVerdictWire> {
    return this.call<RouteVerdictWire>('tasks.route', { taskId });
  }

  // ── the public hub (ADR-0045) ──────────────────────────────────────────────

  /** Preview the PUBLIC view. Reading it publishes nothing. */
  hubPreview(projectId: string): Promise<HubPreviewWire> {
    return this.call<HubPreviewWire>('projects.hub.preview', { projectId });
  }

  /** Publish — approval-gated, and effectively irreversible. */
  hubPublish(params: {
    projectId: string;
    conversationId: string;
  }): Promise<{ slug: string; contentHash: string; url: string }> {
    return this.call('projects.hub.publish', params);
  }

  hubRevoke(params: {
    projectId: string;
    conversationId: string;
    reason: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.hub.revoke', params);
  }

  /** The weekly review packet. Reading it changes nothing. */
  review(projectId: string): Promise<ReviewPacketWire> {
    return this.call<ReviewPacketWire>('projects.review', { projectId });
  }

  /**
   * Run the review now, instead of waiting for the scheduler.
   *
   * It raises Inbox proposals and says one thing in the conversation. It closes
   * nothing, publishes nothing and moves nothing — so this button is safe to press.
   */
  reviewRun(projectId: string): Promise<{ raised: number }> {
    return this.call<{ raised: number }>('projects.review.run', { projectId });
  }

  // ── the retrospective (ADR-0045) ───────────────────────────────────────────

  retro(projectId: string): Promise<RetroPacketWire> {
    return this.call<RetroPacketWire>('projects.retro', { projectId });
  }

  retroRun(params: { projectId: string; conversationId: string }): Promise<{ lessons: string[] }> {
    return this.call('projects.retro.run', params);
  }

  /**
   * Promote ONE lesson into organizational memory — the only path by which anything
   * crosses out of a project. There is deliberately no bulk version.
   */
  retroPromote(params: {
    projectId: string;
    conversationId: string;
    lesson: string;
  }): Promise<{ entryId: string }> {
    return this.call('projects.retro.promote', params);
  }

  // ── settings / preferences (WP5) ───────────────────────────────────────────
  // The generic KV path the daemon reads for context.pack / scribe / scheduler.
  // Values are non-secret booleans/strings only; secrets never travel this way.

  settingGet(key: string): Promise<{ value: unknown }> {
    return this.call<{ value: unknown }>('settings.get', { key });
  }

  settingUpdate(params: {
    projectId: string;
    conversationId: string;
    key: string;
    value: unknown;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('settings.update', params);
  }

  // ── provider model discovery + endpoint probe (WP5) ────────────────────────

  /** Live /models probe with a curated fallback — turns the model field into a picker. */
  providersModels(provider: string): Promise<ModelDiscoveryResultWire> {
    return this.call<ModelDiscoveryResultWire>('providers.models', { provider });
  }

  probeEndpoint(params: { baseUrl: string; keyEnv?: string }): Promise<ProbeEndpointResultWire> {
    return this.call<ProbeEndpointResultWire>('providers.probeEndpoint', params);
  }

  // ── provider accounts (WP5) — env-var NAMES only, never secret values ───────

  accountsList(): Promise<AccountRowWire[]> {
    return this.call<AccountRowWire[]>('accounts.list', {});
  }

  accountsConnect(params: {
    projectId: string;
    conversationId: string;
    provider: string;
    authMode?: string;
    label?: string;
  }): Promise<{ accountId: string }> {
    return this.call<{ accountId: string }>('accounts.connect', params);
  }

  /** Point an account at the ENV VAR NAME that holds its secret. The name, never the value. */
  accountBindSecretRef(params: { accountId: string; envName: string }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('accounts.bindSecretRef', params);
  }

  accountConfigStatus(accountId: string): Promise<{ status: ProviderConfigStatus | null }> {
    return this.call<{ status: ProviderConfigStatus | null }>('accounts.configStatus', {
      accountId,
    });
  }

  // ── channels (WP5) — honest per-channel readiness + pairing ────────────────

  channelsList(): Promise<ChannelStatusEntryWire[]> {
    return this.call<ChannelStatusEntryWire[]>('channels.list', {});
  }

  pairingCreate(params: {
    projectId: string;
    conversationId?: string;
    channel?: 'web' | 'telegram' | 'whatsapp';
  }): Promise<PairingRowWire> {
    return this.call<PairingRowWire>('channels.pairing.create', params);
  }

  pairingList(channel?: 'web' | 'telegram' | 'whatsapp'): Promise<PairingRowWire[]> {
    return this.call<PairingRowWire[]>('channels.pairing.list', channel ? { channel } : {});
  }

  // ── Global Amrita / System Brain (WP5, ADR-0036) ───────────────────────────

  systemHealth(): Promise<SystemHealthResultWire> {
    return this.call<SystemHealthResultWire>('system.health', {});
  }

  /** The self-maintenance audit. `record:true` writes findings; default is read-only. */
  systemAudit(record = false): Promise<SystemAuditResultWire> {
    return this.call<SystemAuditResultWire>('system.audit', { record });
  }

  // ── phases after activation (WP5) ──────────────────────────────────────────

  phaseCreate(params: {
    projectId: string;
    conversationId: string;
    title: string;
    description?: string;
  }): Promise<{ phaseId: string }> {
    return this.call<{ phaseId: string }>('projects.phases.create', params);
  }

  phaseUpdate(params: {
    projectId: string;
    conversationId: string;
    phaseId: string;
    title?: string;
    description?: string;
    status?: string;
  }): Promise<{ ok: boolean }> {
    return this.call<{ ok: boolean }>('projects.phases.update', params);
  }

  // ── Cinema module delegation (WP9, ADR-0029) — honest, bridge-gated ────────

  /** Provider rows for the Cinema module. Throws / errors when the bridge is absent. */
  cinemaProviders(): Promise<unknown> {
    return this.call<unknown>('cinema.providers', {});
  }

  /** Open/resolved mandates — a LOCAL read over this daemon's own events; no bridge needed. */
  cinemaMandateList(conversationId: string, openOnly = false): Promise<CinemaMandateRowWire[]> {
    return this.call<CinemaMandateRowWire[]>('cinema.mandate.list', { conversationId, openOnly });
  }

  /** Hand the task to a supervised lane — approval, budget and receipt all apply. */
  delegateTask(params: {
    projectId: string;
    conversationId: string;
    taskId: string;
  }): Promise<{ laneId: string; status: string }> {
    return this.call('tasks.delegate', params);
  }

  /**
   * The operator approves Amrita's proposal and the project becomes a plan.
   * Nothing is created until this is called (ADR-0045).
   */
  activateProject(params: {
    projectId: string;
    conversationId: string;
    phases: { title: string; description?: string }[];
    milestones?: { title: string; targetDate?: string }[];
    tasks?: { title: string; phaseIndex?: number }[];
  }): Promise<{ phaseIds: string[]; milestoneIds: string[]; taskIds: string[] }> {
    return this.call('projects.activate', params);
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

  /** Read-only project context: git + files, bounded probes (ADR-0034). */
  projectContext(projectId: string): Promise<ProjectContextLite> {
    return this.call<ProjectContextLite>('projects.context', { projectId });
  }

  /** The skill registry (ADR-0035): register + gate, never execute. */
  skillsList(projectId?: string): Promise<SkillStatusLite[]> {
    return this.call<SkillStatusLite[]>('skills.list', projectId ? { projectId } : {});
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
