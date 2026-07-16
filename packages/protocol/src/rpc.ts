import { z } from 'zod';
import { cinemaMandateReportSchema, cinemaMandateSchema } from './cinema.ts';
import { connectorStatusReportSchema } from './connector.ts';
import {
  accountRowSchema,
  connectorRowSchema,
  conversationNodeSchema,
  conversationRowSchema,
  decisionRowSchema,
  inboxItemRowSchema,
  laneRowSchema,
  memoryEntryRowSchema,
  milestoneRowSchema,
  openQuestionRowSchema,
  pairingRowSchema,
  phaseRowSchema,
  previewApprovalRowSchema,
  projectBrandRowSchema,
  projectBriefRowSchema,
  projectRowSchema,
  riskRowSchema,
  taskRowSchema,
} from './entities.ts';
import {
  type EventType,
  authModeSchema,
  inboxKindSchema,
  isStreamOnly,
  laneRowStatusSchema,
  providerConfigStatusSchema,
  providerRoleSchema,
  riskSeveritySchema,
  sealedEventShellSchema,
  sessionRuntimeStateSchema,
  verificationResultSchema,
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

/**
 * Domain events that change PROJECT state rather than one conversation's
 * transcript (ADR-0044). Owned here, once: the daemon decides what to fan out and
 * the web client decides what to refetch from the SAME list — neither re-declares it.
 */
export const PROJECT_DOMAIN_EVENT_PREFIXES = [
  'task.',
  'approval.', // ADR-0050: a session can await approval in another conversation
  'milestone.',
  'question.',
  'risk.',
  'decision.',
  'inbox.',
  'brief.',
  'brand.',
  'memory.',
  'preview.',
  'publication.',
] as const;

// Durable lane lifecycle only. `lane.progress` can be extremely high-volume and
// must not trigger a project-wide projection/snapshot refetch storm (ADR-0050).
const PROJECT_DOMAIN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'lane.spawned',
  'lane.completed',
  'lane.aborted',
]);

export function isProjectDomainEvent(type: string): boolean {
  // Unknown strings are harmless here: Set.has returns false at runtime. The cast
  // keeps this boundary usable by intentionally loose event projections such as the web UI.
  if (isStreamOnly(type as EventType)) return false;
  if (PROJECT_DOMAIN_EVENT_TYPES.has(type)) return true;
  return PROJECT_DOMAIN_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
}

export const wsServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('event'), event: sealedEventShellSchema }),
  z.object({
    t: z.literal('replayed'),
    conversationId: idSchema,
    sinceSeq: z.number().int().nonnegative(),
  }),
  /**
   * A project-scoped domain change (ADR-0044).
   *
   * NO cursor, by design: `seq` is per-conversation, so a project-wide stream has
   * no single monotonic sequence to resume from. This frame is a NOTIFICATION —
   * "this project changed" — and the client refetches the affected projection.
   * Missing one is harmless (the next one re-syncs); replaying one is harmless
   * (a refetch is idempotent).
   */
  z.object({ t: z.literal('project-event'), event: sealedEventShellSchema }),
  /**
   * A project-scoped interactive-session screen update (ADR-0050). Unlike
   * `project-event`, this is ephemeral and must never trigger a projection
   * refetch; unlike `event`, it may originate in another conversation. Only
   * the explicit `lane.pane` allowlist may use this frame.
   */
  z.object({ t: z.literal('project-session-event'), event: sealedEventShellSchema }),
]);
export type WsServerFrame = z.infer<typeof wsServerFrameSchema>;

/**
 * The embedded session TERMINAL socket (ADR-0052) — a dedicated endpoint
 * (`GET /lanes/<laneId>/terminal`), NOT part of the events union above. The
 * browser sends raw key bytes (as a UTF-8 string; the daemon hex-encodes them
 * into `send-keys -H`, so they are bytes, never a command) and resize hints;
 * the daemon streams redacted pane output and an honest exit. Nothing on this
 * socket is ever persisted.
 */
export const terminalClientFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('input'), data: z.string().min(1).max(8192) }).strict(),
  z
    .object({
      t: z.literal('resize'),
      cols: z.number().int().min(20).max(500),
      rows: z.number().int().min(5).max(300),
    })
    .strict(),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;

export const terminalServerFrameSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('output'), data: z.string() }).strict(),
  z.object({ t: z.literal('exit'), reason: z.string().max(200) }).strict(),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

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

export const doctorProfileSchema = z.enum(['core', 'optional', 'private']);
export type DoctorProfile = z.infer<typeof doctorProfileSchema>;

export const doctorSectionSchema = z.object({
  title: z.string(),
  checks: z.array(doctorCheckSchema),
  // Community onboarding: `core` drives the top-line ok/status (the basic chat
  // loop); `optional` integrations and `private` bespoke modules never gate it.
  // Additive-optional: pre-profile reports still parse (absent = treated core).
  profile: doctorProfileSchema.optional(),
});
export type DoctorSection = z.infer<typeof doctorSectionSchema>;

export const doctorReportSchema = z.object({
  ok: z.boolean(),
  status: doctorStatusSchema,
  sections: z.array(doctorSectionSchema),
  fixes: z.array(z.string()),
});
export type DoctorReport = z.infer<typeof doctorReportSchema>;

/**
 * The Conclusion Capsule (ADR-0048) — what Amrita shows the operator INSTEAD of code
 * and logs: Progress / Decisions / Risks / Conflicts / Validation / Next-Actions,
 * each item provenance-linked to the exact lane / task / decision / inbox / approval
 * it came from. This is a DERIVED VIEW delivered as an RPC RESULT (like DoctorReport)
 * — it NEVER enters the event log and is never a write path.
 */
export const capsuleProvenanceSchema = z
  .object({
    kind: z.enum(['lane', 'task', 'decision', 'risk', 'inbox', 'approval', 'event']),
    /** The event id / row id this item came from — the clickable link. */
    ref: z.string(),
    label: z.string().max(200).optional(),
  })
  .strict();

export const capsuleItemSchema = z
  .object({
    text: z.string().min(1).max(500),
    provenance: z.array(capsuleProvenanceSchema).max(8),
  })
  .strict();

export const conclusionCapsuleSchema = z
  .object({
    conversationId: idSchema,
    laneId: idSchema.optional(),
    groupId: idSchema.optional(),
    status: z.enum(['idle', 'running', 'blocked', 'review', 'done', 'aborted']),
    progress: z.array(capsuleItemSchema).max(20),
    decisions: z.array(capsuleItemSchema).max(20),
    risks: z.array(capsuleItemSchema).max(20),
    conflicts: z.array(capsuleItemSchema).max(20),
    validation: z.array(capsuleItemSchema).max(20),
    nextActions: z.array(capsuleItemSchema).max(20),
    rev: z.number().int().nonnegative(),
  })
  .strict();
export type ConclusionCapsule = z.infer<typeof conclusionCapsuleSchema>;
export type CapsuleItem = z.infer<typeof capsuleItemSchema>;

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
export type ModelDiscoveryResultWire = z.infer<typeof modelDiscoveryResultSchema>;

export const probeEndpointResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(z.string()),
  probedUrl: z.string(),
  detail: z.string(),
  suggestedUrl: z.string().optional(),
});
export type ProbeEndpointResultWire = z.infer<typeof probeEndpointResultSchema>;

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

/** Ephemeral, redacted tmux snapshot (ADR-0050). Never persisted. */
export const sessionSnapshotSchema = z.object({
  laneId: idSchema,
  live: z.boolean(),
  state: sessionRuntimeStateSchema,
  text: z.string().max(64_000),
  capturedAt: isoTimestampSchema,
});
export type SessionSnapshotWire = z.infer<typeof sessionSnapshotSchema>;

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

/**
 * What the operator is LOOKING AT right now (ADR-0045).
 *
 * "השיחה עם אמריטה תישאר תמיד מחוברת למה שאתה מסתכל עליו. אם פתחת סיכון, היא
 *  יודעת שאתה מדבר על הסיכון."
 *
 * Sent with a chat turn so the conversation is about the thing on screen, instead
 * of the operator having to re-describe it every time.
 */
export const chatFocusSchema = z
  .object({
    kind: z.enum([
      'task',
      'risk',
      'question',
      'decision',
      'milestone',
      'phase',
      'inbox',
      // ADR-0047: a build the operator selected on the live canvas. It has no
      // stored row (it is a client-only artifact), so it carries a `label`
      // instead of ids — the title shown on the card.
      'artifact',
    ]),
    ids: z.array(idSchema).max(10).default([]),
    /** For `artifact` focus: the on-screen build's title. */
    label: z.string().min(1).max(200).optional(),
  })
  .refine((f) => (f.kind === 'artifact' ? typeof f.label === 'string' : f.ids.length > 0), {
    message: 'a domain focus needs ids; an artifact focus needs a label',
  });
export type ChatFocus = z.infer<typeof chatFocusSchema>;

/**
 * What can actually be DONE with a task (ADR-0045).
 *
 * "לכל משימה באמריטה יהיה מסלול ברור: 'לבצע עכשיו', 'להעביר לסוכן', 'נדרש חיבור
 *  לכלי חיצוני', 'נדרש אישור' או 'משימה אנושית בלבד'."
 */
export const executionRouteSchema = z.enum([
  'do-now',
  'delegate',
  'needs-connector',
  'needs-approval',
  'human-only',
]);
export type ExecutionRouteWire = z.infer<typeof executionRouteSchema>;

export const routeVerdictSchema = z.object({
  route: executionRouteSchema,
  detail: z.string(),
  /** For `needs-connector`: what is missing, why, and what approving it costs. */
  missing: z
    .object({ what: z.string(), why: z.string(), risk: z.string(), fix: z.string() })
    .optional(),
});
export type RouteVerdictWire = z.infer<typeof routeVerdictSchema>;

/**
 * The weekly review packet (ADR-0045). It PROPOSES; it never acts.
 *
 * "פעם בשבוע המתזמן של אמריטה יכין חבילת סקירה, לא יבצע שינויים בשקט."
 */
export const reviewPacketSchema = z.object({
  key: z.string(),
  weekOf: z.string(),
  stale: z.array(
    z.object({ taskId: idSchema, title: z.string(), daysSinceMoved: z.number().int() }),
  ),
  approaching: z.array(
    z.object({
      milestoneId: idSchema,
      title: z.string(),
      targetDate: z.string(),
      daysLeft: z.number().int(),
    }),
  ),
  overdue: z.array(
    z.object({
      milestoneId: idSchema,
      title: z.string(),
      targetDate: z.string(),
      daysLate: z.number().int(),
    }),
  ),
  blockers: z.array(z.object({ taskId: idSchema, title: z.string(), reason: z.string() })),
  waitingDecisions: z.array(
    z.object({ questionId: idSchema, text: z.string(), ageDays: z.number().int() }),
  ),
  openRisks: z.array(
    z.object({ riskId: idSchema, text: z.string(), severity: z.string().nullable() }),
  ),
  recommendations: z.array(z.string()),
  empty: z.boolean(),
});
export type ReviewPacketWire = z.infer<typeof reviewPacketSchema>;

/**
 * The PUBLIC view of a project (ADR-0045).
 *
 * This shape IS the allowlist. Every field a stakeholder may ever see is named
 * here; anything not named is unrepresentable, not merely discouraged.
 */
export const publicHubSchema = z.object({
  projectName: z.string(),
  goal: z.string(),
  audience: z.string().nullable(),
  finishLine: z.string().nullable(),
  milestones: z.array(
    z.object({
      title: z.string(),
      status: z.enum(['planned', 'in-progress', 'done']),
      targetDate: z.string().nullable(),
    }),
  ),
  phases: z.array(
    z.object({ title: z.string(), status: z.enum(['planned', 'in-progress', 'done']) }),
  ),
  /** A COUNT, never a task list — titles leak internal detail. */
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  updates: z.array(z.object({ date: z.string(), text: z.string() })),
  generatedAt: z.string(),
});
export type PublicHubWire = z.infer<typeof publicHubSchema>;

export const hubPreviewSchema = z.object({
  hub: publicHubSchema,
  contentHash: z.string(),
  published: z
    .object({ slug: z.string(), publishedAt: z.string(), inSync: z.boolean() })
    .nullable(),
});
export type HubPreviewWire = z.infer<typeof hubPreviewSchema>;

/**
 * The retrospective (ADR-0045). Computed from what actually happened.
 *
 * `lessons` are CANDIDATES. Nothing crosses into another project until the operator
 * promotes it, one at a time — cross-project contamination is a door we never build.
 */
export const retroPacketSchema = z.object({
  projectId: idSchema,
  outcome: z.object({
    finishLine: z.string().nullable(),
    successCriteria: z.array(z.string()),
    tasksDone: z.number().int(),
    tasksTotal: z.number().int(),
    milestonesHit: z.number().int(),
    milestonesMissed: z.number().int(),
  }),
  findings: z.array(
    z.object({
      kind: z.enum(['slipped', 'unanswered', 'risk-realised', 'dropped', 'never-moved', 'scope']),
      detail: z.string(),
      lesson: z.string().optional(),
    }),
  ),
  lessons: z.array(z.string()),
  empty: z.boolean(),
});
export type RetroPacketWire = z.infer<typeof retroPacketSchema>;

/** One computed charter finding (ADR-0045) — certainty / missing / contradiction. */
export const charterFindingSchema = z.object({
  kind: z.enum(['missing', 'unconfirmed', 'contradiction']),
  severity: z.enum(['low', 'medium', 'high']),
  field: z.string(),
  detail: z.string(),
  ask: z.string().optional(),
});
export type CharterFindingWire = z.infer<typeof charterFindingSchema>;

/** What the project's charter says, and whether it holds together (ADR-0045). */
export const charterStatusSchema = z.object({
  findings: z.array(charterFindingSchema),
  /** Enough basis to propose activating the project. */
  readyToActivate: z.boolean(),
});
export type CharterStatusWire = z.infer<typeof charterStatusSchema>;

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
export type ChannelStatusEntryWire = z.infer<typeof channelStatusEntrySchema>;

export const cinemaMandateRowSchema = z.object({
  mandate: cinemaMandateSchema,
  status: z.enum(['open', 'resolved']),
  report: cinemaMandateReportSchema.optional(),
});
export type CinemaMandateRowWire = z.infer<typeof cinemaMandateRowSchema>;

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
export type SystemHealthResultWire = z.infer<typeof systemHealthResultSchema>;

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
export type SystemAuditResultWire = z.infer<typeof systemAuditResultSchema>;

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
  'orchestration.capsule': conclusionCapsuleSchema,

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
  'lanes.session.send': z.object({ laneId: idSchema, sent: z.boolean() }),
  'lanes.session.finish': z.object({ laneId: idSchema, finished: z.boolean() }),
  'lanes.session.cancel': laneCancelResultSchema,
  'lanes.session.snapshot': sessionSnapshotSchema,
  'project.delete': z.object({ deleted: z.literal(true) }),

  'message.user.record': z.object({ messageId: idSchema, event: sealedEventShellSchema }),
  'events.list': sealedEventListSchema,

  'tasks.create': z.object({ taskId: idSchema }),
  'tasks.list': z.array(taskRowSchema),
  'tasks.update': okTrueSchema,
  'tasks.complete': okTrueSchema,
  // ADR-0055: an operator-initiated acceptance-verification run.
  'tasks.verify': z.object({ passed: z.boolean(), results: z.array(verificationResultSchema) }),
  'harness.importIcs': z.object({ imported: z.number().int().nonnegative() }),

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
  'projects.charter.status': charterStatusSchema, // ADR-0045
  'projects.phases.list': z.array(phaseRowSchema),
  'projects.setRoot': okTrueSchema,
  'tasks.route': routeVerdictSchema,
  'projects.hub.preview': hubPreviewSchema,
  'projects.hub.publish': z.object({
    slug: z.string(),
    contentHash: z.string(),
    url: z.string(),
  }),
  'projects.hub.revoke': okTrueSchema,
  'projects.review': reviewPacketSchema,
  'projects.review.run': z.object({ raised: z.boolean() }),
  'projects.retro': retroPacketSchema,
  'projects.retro.run': z.object({ lessons: z.array(z.string()) }),
  'projects.retro.promote': z.object({ entryId: idSchema }),
  'tasks.delegate': z.object({ laneId: idSchema, status: z.string() }),
  'projects.phases.create': z.object({ phaseId: idSchema }),
  'projects.phases.update': okTrueSchema,
  'projects.activate': z.object({
    phaseIds: z.array(idSchema),
    milestoneIds: z.array(idSchema),
    taskIds: z.array(idSchema),
  }),

  // the Inbox — the one triage queue (ADR-0044)
  'inbox.capture': z.object({ itemId: idSchema }),
  'inbox.list': z.array(inboxItemRowSchema),
  // triage returns what the item BECAME, so the caller can navigate straight to it
  'inbox.triage': z.object({ promotedKind: inboxKindSchema, promotedId: idSchema }),
  'inbox.dismiss': okTrueSchema,

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
