import { z } from 'zod';
import { cinemaMandateReportSchema, cinemaMandateSchema } from './cinema.ts';
import { idSchema, isoTimestampSchema, ulidSchema } from './ids.ts';
import { laneMandateSchema, mergeReportSchema, usageSchema } from './lane.ts';

/**
 * The event protocol — Amrita's constitution.
 *
 * Everything that happens in a conversation is an append-only event with a
 * shared envelope and a per-type payload. Events are totally ordered within a
 * conversation by a monotonic `seq` (assigned by the store inside the append
 * transaction). The envelope is identical across every channel, the daemon, the
 * store, and every lane — nothing crosses a boundary unparsed.
 *
 * Adding or changing an event type requires an ADR (see CLAUDE.md).
 */

export const eventOriginSchema = z.enum(['user', 'agent', 'lane', 'system']);
export type EventOrigin = z.infer<typeof eventOriginSchema>;

export const eventChannelSchema = z.enum(['web', 'telegram', 'whatsapp', 'cli', 'api']);
export type EventChannel = z.infer<typeof eventChannelSchema>;

// ── shared domain enums (ADR-0032) ───────────────────────────────────────────
// Exported so store/daemon/cli/web import them instead of re-declaring. These
// are the single source of truth for every enum that crosses a boundary.

/** The provider roles a turn can ask for instead of a concrete provider (D5). */
export const providerRoleSchema = z.enum(['fast', 'main', 'deep']);
export const PROVIDER_ROLES = providerRoleSchema.options;
export type ProviderRole = z.infer<typeof providerRoleSchema>;

/** Which selection scope chose a turn's provider (ADR-0019 provenance). */
export const runtimeViaSchema = z.enum(['explicit', 'project', 'binding', 'auto', 'default']);
export type RuntimeVia = z.infer<typeof runtimeViaSchema>;

export const taskStatusSchema = z.enum(['now', 'later', 'done', 'dropped']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Task priority (ADR-0044). Deliberately three levels and no score: the project
 * already refuses to invent a risk-scoring system (ADR-0018), and a board does
 * not need one either.
 */
export const taskPrioritySchema = z.enum(['low', 'normal', 'high']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const memoryScopeSchema = z.enum(['user', 'project']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;

export const milestoneStatusSchema = z.enum(['planned', 'active', 'done', 'dropped']);
export type MilestoneStatus = z.infer<typeof milestoneStatusSchema>;

/**
 * A phase (ADR-0045) — the project's OWN shape, which the board's columns come
 * from. Not a milestone: a milestone is a dated outcome you hit or miss; a phase
 * is a stretch of work that tasks live inside.
 *
 * "כך הלוח לא מופיע מתוך תבנית מוכנה. הוא נולד מההקשר הספציפי."
 */
export const phaseStatusSchema = z.enum(['planned', 'active', 'done', 'dropped']);
export type PhaseStatus = z.infer<typeof phaseStatusSchema>;

export const questionStatusSchema = z.enum(['open', 'resolved', 'dropped']);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

export const riskSeveritySchema = z.enum(['low', 'medium', 'high']);
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;

// ── the Inbox (ADR-0044) — the one triage queue ──────────────────────────────
// Everything an agent, a lane or a human captures lands here as a PROPOSAL and
// is promoted into a real aggregate only by an explicit triage. Nothing becomes
// silent, untyped project truth.

/** Who raised the item. `agent` = the Scribe; `lane` = a merge report. */
export const inboxOriginSchema = z.enum(['user', 'agent', 'lane', 'system']);
export type InboxOrigin = z.infer<typeof inboxOriginSchema>;

/** What an inbox item can be promoted INTO — every one an existing aggregate. */
export const inboxKindSchema = z.enum([
  'task',
  'decision',
  'risk',
  'question',
  'milestone',
  'memory',
]);
export type InboxKind = z.infer<typeof inboxKindSchema>;

export const inboxStatusSchema = z.enum(['pending', 'triaged', 'dismissed']);
export type InboxStatus = z.infer<typeof inboxStatusSchema>;

export const inboxConfidenceSchema = z.enum(['low', 'medium', 'high']);
export type InboxConfidence = z.infer<typeof inboxConfidenceSchema>;

/**
 * How sure are we of a fact (ADR-0045)?
 *
 *   stated     — the operator said it. The strongest truth this system has.
 *   documented — it came from a document or an external system.
 *   inferred   — Amrita worked it out. A HYPOTHESIS until a human confirms it.
 *
 * "כך אמריטה לעולם לא תערבב עובדה עם השערה."
 */
export const certaintySchema = z.enum(['stated', 'documented', 'inferred']);
export type Certainty = z.infer<typeof certaintySchema>;

// ── the charter (ADR-0044) — "constraints as fuel" ───────────────────────────

export const constraintKindSchema = z.enum(['budget', 'date', 'resource', 'policy']);
export type ConstraintKind = z.infer<typeof constraintKindSchema>;

/** A constraint the project must live within. `hard` = fixed, not negotiable. */
export const projectConstraintSchema = z
  .object({
    kind: constraintKindSchema,
    text: z.string().min(1).max(300),
    hard: z.boolean(),
  })
  .strict();
export type ProjectConstraint = z.infer<typeof projectConstraintSchema>;

/**
 * Where a task CAME FROM (ADR-0045) — the answer to "why does this card exist?".
 *
 * "פתיחת כרטיס תציג לא רק פרטים, אלא גם למה הוא קיים, מאיזו מטרה, מגבלה,
 *  החלטה או מסמך הוא נגזר."
 */
export const derivationKindSchema = z.enum([
  'goal',
  'constraint',
  'decision',
  'milestone',
  'risk',
  'question',
  'source',
]);
export type DerivationKind = z.infer<typeof derivationKindSchema>;

export const derivationSchema = z
  .object({
    kind: derivationKindSchema,
    /** The row this came from, when it is a row (a decision id, a risk id…). */
    ref: idSchema.optional(),
    /** What it said — so the card can explain itself without a second lookup. */
    label: z.string().min(1).max(300),
  })
  .strict();
export type Derivation = z.infer<typeof derivationSchema>;

/** Who approves what. Free text: there is no user/contact table (see ADR-0044). */
export const decisionRightSchema = z
  .object({ area: z.string().min(1).max(200), approver: z.string().min(1).max(200) })
  .strict();
export type DecisionRight = z.infer<typeof decisionRightSchema>;

export const laneRowStatusSchema = z.enum([
  'spawned',
  'running',
  'merging',
  'completed',
  'aborted',
]);
export type LaneRowStatus = z.infer<typeof laneRowStatusSchema>;

export const connectorStatusSchema = z.enum(['needs_setup', 'ready', 'error', 'disabled']);
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

export const authModeSchema = z.enum(['api_key', 'subscription_cli', 'local_endpoint', 'oauth']);
export type AuthMode = z.infer<typeof authModeSchema>;

export const providerConfigStatusSchema = z.enum([
  'missing_secret_ref',
  'secret_ref_bound',
  'degraded',
  'healthy',
]);
export type ProviderConfigStatus = z.infer<typeof providerConfigStatusSchema>;

export const approvalDecisionSchema = z.enum(['allow', 'deny']);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/** The sealed envelope — carries `seq`, assigned by the store on append. */
export const eventEnvelopeBaseSchema = z
  .object({
    id: ulidSchema,
    seq: z.number().int().nonnegative(),
    ts: isoTimestampSchema,
    projectId: idSchema,
    conversationId: idSchema,
    turnId: idSchema.optional(),
    laneId: idSchema.optional(),
    origin: eventOriginSchema,
    channel: eventChannelSchema.optional(),
  })
  .strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeBaseSchema>;

// ---------------------------------------------------------------------------
// Payloads, by namespace. Keep each payload `.strict()` so unknown keys throw.
// ---------------------------------------------------------------------------

const empty = z.object({}).strict();

const attachmentSchema = z
  .object({
    artifactId: idSchema.optional(),
    name: z.string(),
    mime: z.string().optional(),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

const toolResultSchema = z
  .object({
    // Inline result, OR a pointer to a spilled artifact when the payload is large.
    result: z.unknown().optional(),
    spilledArtifactId: idSchema.optional(),
    preview: z.string().optional(),
    isError: z.boolean().default(false),
  })
  .strict();

/** Keys that must never appear in `settings` (mirrors the store CHECK, ADR-0003). */
const SECRET_KEY_RE = /secret|api[_-]?key|apikey|token|password/i;

/**
 * The canonical map: event type -> payload schema. The keys are the closed set
 * of legal event types. This object IS the protocol surface.
 */
export const eventPayloads = {
  // conversation lifecycle
  'conversation.created': z.object({ title: z.string().optional() }).strict(),
  'conversation.renamed': z.object({ title: z.string() }).strict(),
  'conversation.archived': empty,
  // Compression-as-lineage (ADR-0033): emitted on the PARENT; the child carries
  // the digest as its first message.system. Parent is archived in the same flow.
  'conversation.compressed': z
    .object({
      childConversationId: idSchema,
      summary: z.string().min(1).max(4000),
      messageCount: z.number().int().positive(),
    })
    .strict(),

  // messages
  'message.user': z
    .object({ text: z.string(), attachments: z.array(attachmentSchema).optional() })
    .strict(),
  'message.agent': z.object({ text: z.string() }).strict(),
  'message.system': z.object({ text: z.string() }).strict(),

  // turns
  'turn.started': z.object({ trigger: z.enum(['user', 'schedule', 'channel', 'lane']) }).strict(),
  'turn.completed': z.object({ usage: usageSchema.optional() }).strict(),
  'turn.interrupted': z.object({ reason: z.string().optional() }).strict(),
  'turn.failed': z.object({ error: z.string() }).strict(),

  // model calls
  'model.request': z
    .object({
      provider: z.string(),
      model: z.string(),
      role: providerRoleSchema,
      // Runtime-selection provenance (ADR-0019): which scope chose this
      // provider. Optional so pre-0019 events still parse.
      via: runtimeViaSchema.optional(),
    })
    .strict(),
  // STREAM ONLY — never persisted (see STREAM_ONLY_TYPES).
  'model.delta': z.object({ text: z.string() }).strict(),
  'model.response': z.object({ text: z.string(), finishReason: z.string().optional() }).strict(),
  'model.usage': usageSchema,

  // tools
  'tool.requested': z
    .object({ toolCallId: z.string(), name: z.string(), input: z.unknown() })
    .strict(),
  'tool.approved': z.object({ toolCallId: z.string() }).strict(),
  'tool.denied': z.object({ toolCallId: z.string(), reason: z.string().optional() }).strict(),
  'tool.started': z.object({ toolCallId: z.string(), name: z.string() }).strict(),
  'tool.output': z.object({ toolCallId: z.string(), chunk: z.string() }).strict(),
  'tool.completed': z.object({ toolCallId: z.string(), result: toolResultSchema }).strict(),
  'tool.failed': z.object({ toolCallId: z.string(), error: z.string() }).strict(),

  // lanes
  'lane.spawned': z.object({ laneId: idSchema, kind: z.string() }).strict(),
  'lane.mandate': laneMandateSchema,
  'lane.progress': z
    .object({ note: z.string(), pct: z.number().min(0).max(100).optional() })
    .strict(),
  'lane.merge_report': mergeReportSchema,
  'lane.completed': z.object({ laneId: idSchema, exit: z.string() }).strict(),
  'lane.aborted': z.object({ laneId: idSchema, reason: z.string() }).strict(),
  // STREAM ONLY — the live tmux pane snapshot (ADR-0049), never persisted (like
  // model.delta). For human observation on the Canvas; domain truth comes from the
  // workspace files, not the screen. Redacted of secret-shaped content by the runner.
  'lane.pane': z.object({ laneId: idSchema, text: z.string() }).strict(),

  // module mandates (ADR-0029): Amrita → Cinema delegation. Issued/resolved
  // are the only lifecycle events — progress stays module-local by design.
  'module.mandate.issued': z
    .object({ moduleId: z.string().min(1), mandate: cinemaMandateSchema })
    .strict(),
  'module.mandate.resolved': z
    .object({ moduleId: z.string().min(1), report: cinemaMandateReportSchema })
    .strict(),

  // approvals
  'approval.requested': z
    .object({ approvalId: idSchema, action: z.string(), detail: z.string().optional() })
    .strict(),
  'approval.resolved': z
    .object({ approvalId: idSchema, decision: approvalDecisionSchema })
    .strict(),

  // memory & artifacts
  // memory.written is the markdown-vault file-export signal (path-based), kept
  // distinct from the row-level memory_entries events below. See ADR-0004.
  'memory.written': z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).strict(),
  // A row-level upsert of a memory_entries row (create or update). Carries the
  // bounded content inline (≤4000, the table budget) so the row is rebuildable
  // from the log; `projectId` is present only for project scope. See ADR-0007.
  'memory.updated': z
    .object({
      entryId: idSchema,
      scope: memoryScopeSchema,
      content: z.string().min(1).max(4000),
      projectId: idSchema.optional(),
      source: z.string().optional(),
      sourceMessageId: idSchema.optional(),
    })
    .strict(),
  'memory.consolidated': z
    .object({
      resultEntryId: idSchema,
      sourceEntryIds: z.array(idSchema).min(1),
      content: z.string().min(1).max(4000),
      scope: memoryScopeSchema,
      projectId: idSchema.optional(),
    })
    .strict(),
  'artifact.created': z
    .object({ artifactId: idSchema, kind: z.string(), bytes: z.number().int().nonnegative() })
    .strict(),

  // projects
  'project.created': z.object({ slug: z.string(), name: z.string() }).strict(),
  'project.updated': z.object({ fields: z.array(z.string()) }).strict(),

  // channels
  'channel.connected': z.object({ channel: eventChannelSchema }).strict(),
  'channel.message_in': z.object({ channel: eventChannelSchema, externalId: z.string() }).strict(),
  'channel.message_out': z.object({ channel: eventChannelSchema }).strict(),

  // tasks
  'task.created': z
    .object({
      taskId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      laneId: idSchema.optional(),
      milestoneId: idSchema.optional(),
      title: z.string().min(1),
      status: taskStatusSchema.optional(),
      body: z.string().max(4000).optional(),
      // board fields (ADR-0044). All optional, so every pre-0044 `task.created`
      // event still parses and replays to an identical row.
      owner: z.string().min(1).max(120).optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      priority: taskPrioritySchema.optional(),
      orderKey: z.string().min(1).max(64).optional(),
      blockedReason: z.string().min(1).max(300).optional(),
      certainty: certaintySchema.optional(), // ADR-0045
      phaseId: idSchema.optional(), // ADR-0045
      /** Why this card exists (ADR-0045). */
      derivedFrom: z.array(derivationSchema).max(6).optional(),
      // provenance to an external system, e.g. `github:owner/repo#123` (ADR-0022)
      externalRef: z.string().min(1).max(200).optional(),
    })
    .strict(),
  'task.updated': z
    .object({
      taskId: idSchema,
      status: taskStatusSchema.optional(),
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      // nullable so a task can be UNLINKED from a milestone (ADR-0018)
      milestoneId: idSchema.nullable().optional(),
      // The lane this task is delegated to (ADR-0048). Was a raw-SQL write OFF the
      // event log (`UPDATE tasks SET lane_id`), which made the link invisible to any
      // event-driven watcher. It now rides the event; nullable so a task can be
      // un-delegated. Every pre-0048 `task.updated` still parses (it is absent).
      laneId: idSchema.nullable().optional(),
      // board fields (ADR-0044). Each is NULLABLE as well as optional:
      //   absent  = leave it alone
      //   null    = CLEAR it (un-assign the owner, unblock the task)
      owner: z.string().min(1).max(120).nullable().optional(),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      priority: taskPrioritySchema.nullable().optional(),
      orderKey: z.string().min(1).max(64).optional(),
      blockedReason: z.string().min(1).max(300).nullable().optional(),
      certainty: certaintySchema.nullable().optional(), // ADR-0045
      phaseId: idSchema.nullable().optional(), // ADR-0045 — null unlinks
      derivedFrom: z.array(derivationSchema).max(6).optional(),
      /**
       * ADR-0045 — "אירוע שמספר מי הזיז, מאיזה מצב לאיזה מצב, מתי ולמה".
       *
       * `origin` already says WHO and `ts` says WHEN. These two say FROM WHAT and
       * WHY. `previous` is filled by the store from the row as it was, so the event
       * is self-describing: you can read the history without replaying it.
       */
      previous: z
        .object({
          status: taskStatusSchema.optional(),
          phaseId: idSchema.nullable().optional(),
          owner: z.string().nullable().optional(),
          priority: taskPrioritySchema.nullable().optional(),
          blockedReason: z.string().nullable().optional(),
          milestoneId: idSchema.nullable().optional(),
        })
        .strict()
        .optional(),
      reason: z.string().min(1).max(300).optional(),
    })
    .strict(),
  'task.completed': z.object({ taskId: idSchema }).strict(),

  // project companion (ADR-0018) — brief / open questions / risks / milestones.
  // The brief is a FULL-document upsert: replaying the log rebuilds the row.
  'brief.updated': z
    .object({
      projectId: idSchema,
      goal: z.string().min(1).max(2000),
      audience: z.string().min(1).max(500).optional(),
      successCriteria: z.array(z.string().min(1).max(500)).max(20),
      scope: z.array(z.string().min(1).max(500)).max(50),
      noScope: z.array(z.string().min(1).max(500)).max(50),
      // The charter (ADR-0044). All optional, so every pre-0044 `brief.updated`
      // event still parses and replays to an identical row.
      finishLine: z.string().min(1).max(500).optional(),
      constraints: z.array(projectConstraintSchema).max(20).optional(),
      decisionRights: z.array(decisionRightSchema).max(20).optional(),
      /** Per-field certainty, e.g. `{goal:'stated', finishLine:'inferred'}` (ADR-0045). */
      certainty: z.record(z.string(), certaintySchema).optional(),
      sourceMessageId: idSchema.optional(),
    })
    .strict(),
  'question.opened': z
    .object({
      questionId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      text: z.string().min(1).max(2000),
      certainty: certaintySchema.optional(), // ADR-0045
    })
    .strict(),
  // Resolving needs evidence: a note or a decision link — never a silent close.
  'question.resolved': z
    .object({
      questionId: idSchema,
      resolution: z.string().min(1).max(2000).optional(),
      resolvedByDecisionId: idSchema.optional(),
    })
    .strict()
    .refine((p) => p.resolution !== undefined || p.resolvedByDecisionId !== undefined, {
      message: 'a resolved question needs a resolution note or a decision link',
    }),
  'question.dropped': z
    .object({ questionId: idSchema, reason: z.string().min(1).max(2000) })
    .strict(),
  'risk.opened': z
    .object({
      riskId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      text: z.string().min(1).max(2000),
      severity: riskSeveritySchema.optional(),
      certainty: certaintySchema.optional(), // ADR-0045
    })
    .strict(),
  'risk.resolved': z
    .object({
      riskId: idSchema,
      resolution: z.string().min(1).max(2000).optional(),
      resolvedByDecisionId: idSchema.optional(),
    })
    .strict()
    .refine((p) => p.resolution !== undefined || p.resolvedByDecisionId !== undefined, {
      message: 'a resolved risk needs a resolution note or a decision link',
    }),
  'risk.dropped': z.object({ riskId: idSchema, reason: z.string().min(1).max(2000) }).strict(),
  'milestone.created': z
    .object({
      milestoneId: idSchema,
      projectId: idSchema,
      title: z.string().min(1).max(300),
      description: z.string().min(1).max(2000).optional(),
      targetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'targetDate must be YYYY-MM-DD')
        .optional(),
      status: milestoneStatusSchema.optional(),
    })
    .strict(),
  'milestone.updated': z
    .object({
      milestoneId: idSchema,
      title: z.string().min(1).max(300).optional(),
      description: z.string().min(1).max(2000).optional(),
      status: milestoneStatusSchema.optional(),
      targetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'targetDate must be YYYY-MM-DD')
        .nullable()
        .optional(),
    })
    .strict(),
  'milestone.completed': z.object({ milestoneId: idSchema }).strict(),

  // ── phases + activation (ADR-0045) ────────────────────────────────────────
  'phase.created': z
    .object({
      phaseId: idSchema,
      projectId: idSchema,
      title: z.string().min(1).max(120),
      description: z.string().max(1000).optional(),
      status: phaseStatusSchema.optional(),
      orderKey: z.string().min(1).max(64).optional(),
    })
    .strict(),
  'phase.updated': z
    .object({
      phaseId: idSchema,
      title: z.string().min(1).max(120).optional(),
      description: z.string().max(1000).nullable().optional(),
      status: phaseStatusSchema.optional(),
      orderKey: z.string().min(1).max(64).optional(),
    })
    .strict(),
  /**
   * The project stops being a conversation and becomes a plan. Emitted ONLY after
   * the operator approves Amrita's proposal — she never conjures a board unasked.
   */
  // ── the public hub (ADR-0045) ─────────────────────────────────────────────
  // Publishing is CONSEQUENTIAL: it is one of the few things in this system that
  // cannot be taken back (a page someone already fetched is out in the world).
  // So it is approval-gated, and both directions are on the audit log.
  'publication.published': z
    .object({
      projectId: idSchema,
      publicSlug: z.string().min(16).max(64),
      contentHash: z.string().min(1).max(64),
    })
    .strict(),
  'publication.revoked': z
    .object({ projectId: idSchema, reason: z.string().min(1).max(300) })
    .strict(),

  'project.activated': z
    .object({
      projectId: idSchema,
      phaseCount: z.number().int().nonnegative(),
      milestoneCount: z.number().int().nonnegative(),
      taskCount: z.number().int().nonnegative(),
    })
    .strict(),

  // ── the Inbox (ADR-0044) ───────────────────────────────────────────────────
  // The single triage queue. A capture is a PROPOSAL: it carries what was seen
  // (`text`), optionally what it looks like (`suggestedKind` + `suggested`, the
  // payload for the target command), why (`rationale`), and how sure the raiser
  // is. It is NOT project truth until someone triages it.
  'inbox.captured': z
    .object({
      itemId: idSchema,
      projectId: idSchema,
      origin: inboxOriginSchema,
      text: z.string().min(1).max(2000),
      suggestedKind: inboxKindSchema.optional(),
      /** The proposed command payload, validated at triage against the real command. */
      suggested: z.record(z.string(), z.unknown()).optional(),
      rationale: z.string().min(1).max(1000).optional(),
      confidence: inboxConfidenceSchema.optional(),
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
    })
    .strict(),
  // A promotion must NAME what it became — the store CHECK enforces the same
  // invariant, so a silent triage is impossible at the SQL layer too.
  'inbox.triaged': z
    .object({
      itemId: idSchema,
      promotedKind: inboxKindSchema,
      promotedId: idSchema,
    })
    .strict(),
  // Dismissal needs a reason, exactly like question.dropped / risk.dropped:
  // nothing leaves the queue silently (the ADR-0018 house rule).
  'inbox.dismissed': z.object({ itemId: idSchema, reason: z.string().min(1).max(500) }).strict(),

  // brand memory + preview approvals (ADR-0020)
  // The brand is a FULL-document upsert like the brief; an empty write is
  // rejected — no brand row IS the honest empty state, never invented identity.
  'brand.updated': z
    .object({
      projectId: idSchema,
      name: z.string().min(1).max(200).optional(),
      audience: z.string().min(1).max(500).optional(),
      tone: z.string().min(1).max(500).optional(),
      styleNotes: z.array(z.string().min(1).max(300)).max(20),
      palette: z.array(z.string().min(1).max(100)).max(12),
      typography: z.string().min(1).max(500).optional(),
      doNotUse: z.array(z.string().min(1).max(300)).max(20),
      sourceMessageId: idSchema.optional(),
    })
    .strict()
    .refine(
      (p) =>
        p.name !== undefined ||
        p.audience !== undefined ||
        p.tone !== undefined ||
        p.typography !== undefined ||
        p.styleNotes.length > 0 ||
        p.palette.length > 0 ||
        p.doNotUse.length > 0,
      { message: 'a brand update needs at least one substantive field' },
    ),
  // Approves content-hash H of a deterministic surface preview for a project.
  // previewId is a stable surface id (e.g. "html-preview:<projectId>"), not a ULID.
  'preview.approved': z
    .object({
      previewId: z.string().min(1).max(120),
      projectId: idSchema,
      contentHash: z.string().min(1).max(64),
      sourceMessageId: idSchema.optional(),
    })
    .strict(),

  // decisions (append-only log)
  'decision.recorded': z
    .object({
      decisionId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      text: z.string().min(1),
    })
    .strict(),
  'decision.superseded': z
    .object({
      decisionId: idSchema,
      supersedesId: idSchema,
      projectId: idSchema,
      conversationId: idSchema.optional(),
      sourceMessageId: idSchema.optional(),
      text: z.string().min(1),
    })
    .strict(),

  // providers (account + runtime health transitions)
  'provider.connected': z
    .object({
      provider: z.string(),
      accountId: idSchema.optional(),
      authMode: authModeSchema,
      label: z.string().min(1).max(200).optional(),
    })
    .strict(),
  'provider.degraded': z
    .object({ provider: z.string(), accountId: idSchema.optional(), reason: z.string() })
    .strict(),
  'provider.restored': z.object({ provider: z.string(), accountId: idSchema.optional() }).strict(),

  // connectors
  'connector.installed': z
    .object({ connectorId: idSchema, slug: z.string(), kind: z.string() })
    .strict(),
  'connector.updated': z
    .object({
      connectorId: idSchema,
      slug: z.string(),
      status: connectorStatusSchema.optional(),
      fields: z.array(z.string()).optional(),
    })
    .strict(),
  'connector.removed': z.object({ connectorId: idSchema, slug: z.string() }).strict(),

  // settings (non-secret config; secret-ish keys rejected, mirroring the store)
  'settings.updated': z
    .object({ key: z.string().min(1), value: z.unknown() })
    .strict()
    .refine((p) => !SECRET_KEY_RE.test(p.key), {
      message: 'settings keys must not look like secrets (use accounts.secret_ref)',
    })
    // Defense-in-depth for the store gate: `cascade.*` toggles the decisions
    // append-only DELETE guard and is only ever set by the store's own
    // deleteProject transaction (a direct INSERT, never an event), so no
    // legitimate settings.updated event carries it.
    .refine((p) => !p.key.startsWith('cascade.'), {
      message: 'settings keys under "cascade." are reserved for internal use',
    }),

  // diagnostics
  'error.raised': z.object({ message: z.string(), code: z.string().optional() }).strict(),
  'audit.logged': z.object({ action: z.string(), target: z.string().optional() }).strict(),
} as const;

export type EventPayloads = typeof eventPayloads;
export type EventType = keyof EventPayloads;

/** Event types that may be emitted on the live stream but MUST NOT be persisted. */
export const STREAM_ONLY_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'model.delta',
  'lane.pane',
]);

export const eventTypeSchema = z.enum(Object.keys(eventPayloads) as [EventType, ...EventType[]]);

/** A fully-typed, sealed event for a given type `T`. */
export type AmritaEvent<T extends EventType = EventType> = {
  [K in T]: EventEnvelope & { type: K; payload: z.infer<EventPayloads[K]> };
}[T];

/** An event a producer emits before the store assigns `seq`. */
export type UnsealedEvent<T extends EventType = EventType> = Omit<AmritaEvent<T>, 'seq'>;

// ---------------------------------------------------------------------------
// Parsers. Base-parse the envelope, then dispatch the payload by `type`.
// ---------------------------------------------------------------------------

const sealedShellSchema = eventEnvelopeBaseSchema.extend({
  type: eventTypeSchema,
  payload: z.unknown(),
});

/**
 * The wire shape of one sealed event (ADR-0032): envelope fully validated, the
 * payload kept as an opaque object — `parseEvent` is the payload authority.
 * Every payload in `eventPayloads` is an object, so `record` is always valid.
 */
export const sealedEventShellSchema = eventEnvelopeBaseSchema.extend({
  type: eventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type SealedEventShell = z.infer<typeof sealedEventShellSchema>;

const unsealedShellSchema = eventEnvelopeBaseSchema
  .omit({ seq: true })
  .extend({ type: eventTypeSchema, payload: z.unknown() });

function parsePayload<T extends EventType>(type: T, payload: unknown): z.infer<EventPayloads[T]> {
  const schema = eventPayloads[type];
  return schema.parse(payload) as z.infer<EventPayloads[T]>;
}

/** Parse a sealed event (envelope incl. `seq` + dispatched payload). Throws on mismatch. */
export function parseEvent(input: unknown): AmritaEvent {
  const shell = sealedShellSchema.parse(input);
  const payload = parsePayload(shell.type, shell.payload);
  return { ...shell, payload } as AmritaEvent;
}

/** Parse an unsealed event (no `seq` yet). Throws on mismatch. */
export function parseUnsealedEvent(input: unknown): UnsealedEvent {
  const shell = unsealedShellSchema.parse(input);
  const payload = parsePayload(shell.type, shell.payload);
  return { ...shell, payload } as UnsealedEvent;
}

/** Type guard: is this a stream-only event type that must not be persisted? */
export function isStreamOnly(type: EventType): boolean {
  return STREAM_ONLY_TYPES.has(type);
}
