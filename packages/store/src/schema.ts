import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from 'drizzle-orm/sqlite-core';

/**
 * The canonical Drizzle table definitions. These mirror migrations/0000_init.sql
 * and 0001_full_store_schema.sql and are the typed surface for queries in later
 * phases (and the source for drizzle-kit migration generation). The runtime
 * store (store.ts) drives better-sqlite3 directly for fine-grained control over
 * per-conversation `seq` assignment, the FTS5 virtual table, and the hybrid
 * append transaction — none of which an ORM expresses cleanly. Triggers,
 * GENERATED columns, and GLOB/LIKE CHECKs live only in the SQL migration, which
 * is the source of truth; this schema must stay in lock-step with it (enforced
 * by an ADR when either changes — see ADR-0003/0005).
 */

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  root: text('root'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

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
    role: text('role', { enum: ['user', 'agent', 'system'] }).notNull(),
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
    origin: text('origin', { enum: ['user', 'agent', 'lane', 'system'] }).notNull(),
    channel: text('channel', { enum: ['web', 'telegram', 'cli', 'api'] }),
    type: text('type').notNull(),
    payloadJson: text('payload_json').notNull(),
  },
  (t) => ({
    bySeq: unique('uq_events_conversation_seq').on(t.conversationId, t.seq),
    byConversationSeq: index('idx_events_conversation_seq').on(t.conversationId, t.seq),
    byType: index('idx_events_type').on(t.type),
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
    status: text('status', { enum: ['now', 'later', 'done', 'dropped'] })
      .notNull()
      .default('now'),
    title: text('title').notNull(),
    body: text('body'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ byProjectStatus: index('idx_tasks_project_status').on(t.projectId, t.status) }),
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
    scope: text('scope', { enum: ['user', 'project'] }).notNull(),
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
    status: text('status', {
      enum: ['spawned', 'running', 'merging', 'completed', 'aborted'],
    })
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
    authMode: text('auth_mode', {
      enum: ['api_key', 'subscription_cli', 'local_endpoint', 'oauth'],
    }).notNull(),
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
  status: text('status', { enum: ['needs_setup', 'ready', 'error', 'disabled'] })
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
