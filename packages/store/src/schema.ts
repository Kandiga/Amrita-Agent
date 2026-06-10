import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * The canonical Drizzle table definitions. These mirror migrations/0000_init.sql
 * exactly and are the typed surface for queries in later phases (and the source
 * for drizzle-kit migration generation). The runtime store (store.ts) drives
 * better-sqlite3 directly for fine-grained control over per-conversation `seq`
 * assignment, the FTS5 virtual table, and the hybrid append transaction — none
 * of which an ORM expresses cleanly. The hand-written SQL migration is the
 * source of truth; this schema must stay in lock-step with it (enforced by an
 * ADR when either changes).
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
  },
  (t) => ({ byProject: index('idx_conversations_project').on(t.projectId) }),
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
