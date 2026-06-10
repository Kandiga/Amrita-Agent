-- Amrita v2 store — initial schema (migration 0000).
-- Append-only event log is the source of truth; projects/conversations/messages
-- are materialized read-model rows. FTS5 indexes message text for ranked recall.
-- This file is reversible by 0000_init.down.sql.

PRAGMA foreign_keys = ON;

-- ── projects ──────────────────────────────────────────────────────────────
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,            -- ULID
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  root        TEXT,                         -- working directory, nullable
  created_at  TEXT NOT NULL,               -- ISO-8601
  updated_at  TEXT NOT NULL
);

-- ── conversations ─────────────────────────────────────────────────────────
CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,           -- ULID
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);
CREATE INDEX idx_conversations_project ON conversations(project_id);

-- ── messages (read model) ─────────────────────────────────────────────────
-- content_json is the source value; `content` is a generated projection of its
-- text used as the FTS external-content source.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,          -- ULID
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id       TEXT,
  role          TEXT NOT NULL CHECK (role IN ('user','agent','system')),
  content_json  TEXT NOT NULL,             -- {"text": "...", ...}
  content       TEXT GENERATED ALWAYS AS (json_extract(content_json, '$.text')) VIRTUAL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);

-- ── events (append-only log, the source of truth) ─────────────────────────
CREATE TABLE events (
  id              TEXT PRIMARY KEY,        -- ULID
  seq             INTEGER NOT NULL,        -- per-conversation monotonic
  ts              TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  lane_id         TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('user','agent','lane','system')),
  channel         TEXT CHECK (channel IN ('web','telegram','cli','api')),
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX idx_events_conversation_seq ON events(conversation_id, seq);
CREATE INDEX idx_events_type ON events(type);

-- ── artifacts (spilled tool payloads & other blobs) ───────────────────────
CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,        -- ULID
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  path            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      TEXT NOT NULL
);

-- ── full-text search over message text (external content) ─────────────────
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='rowid'
);

-- Keep the FTS index in sync with the messages table.
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content)
  VALUES (new.rowid, json_extract(new.content_json, '$.text'));
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  VALUES ('delete', old.rowid, json_extract(old.content_json, '$.text'));
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  VALUES ('delete', old.rowid, json_extract(old.content_json, '$.text'));
  INSERT INTO messages_fts(rowid, content)
  VALUES (new.rowid, json_extract(new.content_json, '$.text'));
END;
