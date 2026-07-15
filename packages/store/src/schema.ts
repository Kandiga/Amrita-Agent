import {
  authModeSchema,
  certaintySchema,
  connectorStatusSchema,
  eventChannelSchema,
  eventOriginSchema,
  inboxConfidenceSchema,
  inboxKindSchema,
  inboxOriginSchema,
  inboxStatusSchema,
  laneRowStatusSchema,
  memoryScopeSchema,
  messageRoleSchema,
  milestoneStatusSchema,
  phaseStatusSchema,
  questionStatusSchema,
  riskSeveritySchema,
  taskPrioritySchema,
  taskStatusSchema,
} from '@amrita/protocol';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

/** zod `.options` is a plain array; Drizzle wants a non-empty tuple — one cast, here only. */
const columnEnum = <T extends string>(schema: { options: T[] }): [T, ...T[]] =>
  schema.options as [T, ...T[]];

/**
 * The canonical Drizzle table definitions. These mirror migrations/0000_init.sql
 * and 0001_full_store_schema.sql and are the typed surface for queries in later
 * phases (and the source for drizzle-kit migration generation). The runtime
 * store (store.ts) drives better-sqlite3 directly for fine-grained control over
 * per-conversation `seq` assignment, the FTS5 virtual table, and the hybrid
 * append transaction — none of which an ORM expresses cleanly. Triggers,
 * GENERATED columns, GLOB/LIKE CHECKs, and the FTS5 virtual tables
 * (`messages_fts`, `memory_entries_fts`) live only in the SQL migrations, which
 * are the source of truth; this schema must stay in lock-step with them
 * (enforced by an ADR when either changes — see ADR-0003/0005/0008).
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  root: text('root'),
  /** 0014 (ADR-0045): null = a conversation, not yet a plan. */
  activatedAt: text('activated_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 0014 (ADR-0045): phases — the project's own shape, which the board reads. */
export const phases = sqliteTable(
  'phases',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: columnEnum(phaseStatusSchema) })
      .notNull()
      .default('planned'),
    orderKey: text('order_key'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byProject: index('idx_phases_project').on(t.projectId, t.status, t.orderKey) }),
);

export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    title: text('title'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
    // Lineage: self-reference, integrity enforced by SQL triggers (not an FK
    // clause) so DROP COLUMN stays legal on the down path. See ADR-0003.
    parentId: text('parent_id'),
  },
  (t) => ({
    byProject: index('idx_conversations_project').on(t.projectId),
    byParent: index('idx_conversations_parent').on(t.parentId),
  }),
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    turnId: text('turn_id'),
    role: text('role', { enum: columnEnum(messageRoleSchema) }).notNull(),
    contentJson: text('content_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ byConversation: index('idx_messages_conversation').on(t.conversationId) }),
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    seq: integer('seq').notNull(),
    ts: text('ts').notNull(),
    projectId: text('project_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    turnId: text('turn_id'),
    laneId: text('lane_id'),
    origin: text('origin', { enum: columnEnum(eventOriginSchema) }).notNull(),
    channel: text('channel', { enum: columnEnum(eventChannelSchema) }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => ({
    bySeq: unique('uq_events_conversation_seq').on(t.conversationId, t.seq),
    byConversationSeq: index('idx_events_conversation_seq').on(t.conversationId, t.seq),
    byType: index('idx_events_type').on(t.type),
    // The project timeline read (`listProjectEvents`). Created in 0004, silently
    // dropped by the 0007 table rebuild, restored in 0009 (ADR-0044) — and never
    // declared here until now, so the mirror was out of lock-step with the SQL.
    byProjectTs: index('idx_events_project_ts').on(t.projectId, t.ts),
  }),
);

export const artifacts = sqliteTable('artifacts', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id'),
  kind: text('kind').notNull(),
  path: text('path').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: text('created_at').notNull(),
});

export const schemaMigrations = sqliteTable('schema_migrations', {
  version: integer('version').primaryKey(),
  appliedAt: text('applied_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

// ── 0001: full entity baseline (ADR-0003) ───────────────────────────────────

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    sourceMessageId: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    laneId: text('lane_id'),
    status: text('status', { enum: columnEnum(taskStatusSchema) })
      .notNull()
      .default('now'),
    title: text('title').notNull(),
    body: text('body'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    // 0004: milestone linkage, trigger-enforced (no FK clause) — see ADR-0018.
    milestoneId: text('milestone_id'),
    // 0006: external provenance, e.g. `github:owner/repo#123` — see ADR-0022.
    externalRef: text('external_ref'),
    // 0012 (ADR-0044): the board. `blockedReason` non-null IS the "Waiting"
    // column — the status enum is NOT widened (SQLite cannot alter a CHECK).
    owner: text('owner'),
    dueDate: text('due_date'),
    priority: text('priority', { enum: columnEnum(taskPrioritySchema) }),
    /** Lexicographic fractional index: a drag is ONE event touching ONE row. */
    orderKey: text('order_key'),
    blockedReason: text('blocked_reason'),
    // 0013 (ADR-0045): fact vs hypothesis.
    certainty: text('certainty', { enum: columnEnum(certaintySchema) }),
    // 0014 (ADR-0045): the phase this task lives in; trigger-enforced, no FK clause.
    phaseId: text('phase_id'),
  },
  (t) => ({
    byProjectStatus: index('idx_tasks_project_status').on(t.projectId, t.status),
    byMilestone: index('idx_tasks_milestone').on(t.milestoneId),
    byBoard: index('idx_tasks_board').on(t.projectId, t.status, t.orderKey),
  }),
);

/**
 * Append-only decision log. UPDATE/DELETE are blocked by SQL triggers; provenance
 * pointers (conversation_id, source_message_id) are plain columns without FK
 * actions so they never provoke an UPDATE the guard would abort. See ADR-0003.
 */
export const decisions = sqliteTable(
  'decisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    conversationId: text('conversation_id'),
    sourceMessageId: text('source_message_id'),
    supersedesId: text('supersedes_id'),
    text: text('text').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    byProject: index('idx_decisions_project').on(t.projectId),
    supersedes: foreignKey({
      columns: [t.supersedesId],
      foreignColumns: [t.id],
      name: 'fk_decisions_supersedes',
    }),
  }),
);

export const memoryEntries = sqliteTable(
  'memory_entries',
  {
    id: text('id').primaryKey(),
    scope: text('scope', { enum: columnEnum(memoryScopeSchema) }).notNull(),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    charCount: integer('char_count').generatedAlwaysAs(sql`length(content)`, { mode: 'virtual' }),
    source: text('source'),
    sourceMessageId: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byScopeProject: index('idx_memory_scope_project').on(t.scope, t.projectId),
    withinBudget: check('memory_entries_char_budget', sql`length(${t.content}) <= 4000`),
    scopeConsistent: check(
      'memory_entries_scope',
      sql`(${t.scope} = 'project' AND ${t.projectId} IS NOT NULL) OR (${t.scope} = 'user' AND ${t.projectId} IS NULL)`,
    ),
  }),
);

export const lanes = sqliteTable(
  'lanes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status', { enum: columnEnum(laneRowStatusSchema) })
      .notNull()
      .default('spawned'),
    mandateJson: text('mandate_json').notNull(),
    budgetJson: text('budget_json'),
    mergeJson: text('merge_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byConversation: index('idx_lanes_conversation').on(t.conversationId) }),
);

/**
 * Provider accounts. `secretRef` is an ENV-NAME pointing into the secrets file,
 * never a secret value; a SQL CHECK enforces the `^[A-Z][A-Z0-9_]*$` shape.
 */
export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    label: text('label'),
    authMode: text('auth_mode', { enum: columnEnum(authModeSchema) }).notNull(),
    secretRef: text('secret_ref'),
    metadataJson: text('metadata_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byProviderLabel: unique('uq_accounts_provider_label').on(t.provider, t.label),
    secretRefIsEnvName: check(
      'accounts_secret_ref_envname',
      sql`${t.secretRef} IS NULL OR (${t.secretRef} NOT GLOB '*[^A-Z0-9_]*' AND substr(${t.secretRef}, 1, 1) GLOB '[A-Z]')`,
    ),
  }),
);

export const connectors = sqliteTable('connectors', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  kind: text('kind').notNull(),
  status: text('status', { enum: columnEnum(connectorStatusSchema) })
    .notNull()
    .default('needs_setup'),
  manifestJson: text('manifest_json'),
  configJson: text('config_json'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Non-secret config values only. A SQL CHECK rejects secret-ish keys. */
export const settings = sqliteTable(
  'settings',
  {
    key: text('key').primaryKey(),
    valueJson: text('value_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    noSecretKeys: check(
      'settings_no_secret_keys',
      sql`lower(${t.key}) NOT LIKE '%secret%' AND lower(${t.key}) NOT LIKE '%api_key%' AND lower(${t.key}) NOT LIKE '%apikey%' AND lower(${t.key}) NOT LIKE '%token%' AND lower(${t.key}) NOT LIKE '%password%'`,
    ),
  }),
);

// ── 0004: Project Companion Core (ADR-0018) ────────────────────────────────

/** One upsert-document brief per project; arrays stored as JSON strings. */
export const projectBriefs = sqliteTable('project_briefs', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  goal: text('goal').notNull(),
  audience: text('audience'),
  successCriteriaJson: text('success_criteria_json').notNull().default('[]'),
  scopeJson: text('scope_json').notNull().default('[]'),
  noScopeJson: text('no_scope_json').notNull().default('[]'),
  // the charter (ADR-0044) — 0011
  finishLine: text('finish_line'),
  constraintsJson: text('constraints_json').notNull().default('[]'),
  decisionRightsJson: text('decision_rights_json').notNull().default('[]'),
  sourceMessageId: text('source_message_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/**
 * Open questions. Lifecycle CHECKs (resolved needs a note or decision link;
 * dropped needs a reason) and the decision-existence triggers live in the SQL
 * migration, the source of truth.
 */
export const openQuestions = sqliteTable(
  'open_questions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    sourceMessageId: text('source_message_id'),
    text: text('text').notNull(),
    status: text('status', { enum: columnEnum(questionStatusSchema) })
      .notNull()
      .default('open'),
    resolution: text('resolution'),
    resolvedByDecisionId: text('resolved_by_decision_id'),
    dropReason: text('drop_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byProjectStatus: index('idx_questions_project_status').on(t.projectId, t.status) }),
);

export const risks = sqliteTable(
  'risks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    sourceMessageId: text('source_message_id'),
    text: text('text').notNull(),
    severity: text('severity', { enum: columnEnum(riskSeveritySchema) }),
    status: text('status', { enum: columnEnum(questionStatusSchema) })
      .notNull()
      .default('open'),
    resolution: text('resolution'),
    resolvedByDecisionId: text('resolved_by_decision_id'),
    dropReason: text('drop_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byProjectStatus: index('idx_risks_project_status').on(t.projectId, t.status) }),
);

export const milestones = sqliteTable(
  'milestones',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: columnEnum(milestoneStatusSchema) })
      .notNull()
      .default('planned'),
    targetDate: text('target_date'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byProject: index('idx_milestones_project').on(t.projectId, t.status) }),
);

// ── 0005: brand memory + preview approvals (ADR-0020) ──────────────────────

/** One brand document per project; arrays stored as JSON strings. */
export const projectBrands = sqliteTable('project_brands', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name'),
  audience: text('audience'),
  tone: text('tone'),
  styleNotesJson: text('style_notes_json').notNull().default('[]'),
  paletteJson: text('palette_json').notNull().default('[]'),
  typography: text('typography'),
  doNotUseJson: text('do_not_use_json').notNull().default('[]'),
  sourceMessageId: text('source_message_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Durable approvals of deterministic preview content hashes. */
export const previewApprovals = sqliteTable(
  'preview_approvals',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    previewId: text('preview_id').notNull(),
    contentHash: text('content_hash').notNull(),
    sourceMessageId: text('source_message_id'),
    approvedAt: text('approved_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.projectId, t.previewId] }) }),
);

// ── 0010: the Inbox — the one triage queue (ADR-0044) ────────────────────────
// The two "no silent exit" CHECKs (triaged ⇒ promoted_*, dismissed ⇒ reason)
// live in the SQL migration; Drizzle mirrors the shape, the migration is truth.
export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    sourceMessageId: text('source_message_id').references(() => messages.id, {
      onDelete: 'set null',
    }),
    origin: text('origin', { enum: columnEnum(inboxOriginSchema) }).notNull(),
    text: text('text').notNull(),
    suggestedKind: text('suggested_kind', { enum: columnEnum(inboxKindSchema) }),
    suggestedJson: text('suggested_json'),
    rationale: text('rationale'),
    confidence: text('confidence', { enum: columnEnum(inboxConfidenceSchema) }),
    status: text('status', { enum: columnEnum(inboxStatusSchema) })
      .notNull()
      .default('pending'),
    promotedKind: text('promoted_kind', { enum: columnEnum(inboxKindSchema) }),
    promotedId: text('promoted_id'),
    dismissReason: text('dismiss_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    byProjectStatus: index('idx_inbox_project_status').on(t.projectId, t.status, t.createdAt),
  }),
);

/** 0017 (ADR-0045): the public hub. The BYTES are on disk; this is the fact. */
export const projectPublications = sqliteTable('project_publications', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  publicSlug: text('public_slug').notNull().unique(),
  contentHash: text('content_hash').notNull(),
  publishedAt: text('published_at').notNull(),
  revokedAt: text('revoked_at'),
});

// ── 0003: channel pairings (links external identities → project/conversation) ──
export const channelPairings = sqliteTable(
  'channel_pairings',
  {
    code: text('code').primaryKey(),
    channel: text('channel').notNull(),
    projectId: text('project_id').notNull(),
    conversationId: text('conversation_id'),
    claimedBy: text('claimed_by'),
    createdAt: text('created_at').notNull(),
    claimedAt: text('claimed_at'),
  },
  (t) => ({ byClaim: index('idx_channel_pairings_claim').on(t.channel, t.claimedBy) }),
);
