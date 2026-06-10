-- Amrita v2 store — full entity baseline (migration 0001).
-- Completes the approved v1.0 plan §3.3 store schema on top of the 0000 spine:
-- conversation lineage + tasks, decisions, memory_entries, lanes, accounts,
-- connectors, settings. Source of truth for constraints (triggers, generated
-- columns, CHECKs) that the Drizzle mirror cannot express. See ADR-0003/0005.
-- Reversible by 0001_full_store_schema.down.sql.

-- ── conversation lineage ──────────────────────────────────────────────────
-- Trigger-enforced self-reference (no FK clause, so DROP COLUMN stays legal on
-- the down path). See ADR-0003.
ALTER TABLE conversations ADD COLUMN parent_id TEXT;
CREATE INDEX idx_conversations_parent ON conversations(parent_id);

CREATE TRIGGER conversations_parent_ins
BEFORE INSERT ON conversations
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.parent_id = NEW.id
      THEN RAISE(ABORT, 'conversation cannot be its own parent')
    WHEN (SELECT 1 FROM conversations WHERE id = NEW.parent_id) IS NULL
      THEN RAISE(ABORT, 'parent conversation does not exist')
  END;
END;

CREATE TRIGGER conversations_parent_upd
BEFORE UPDATE OF parent_id ON conversations
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NEW.parent_id = NEW.id
      THEN RAISE(ABORT, 'conversation cannot be its own parent')
    WHEN (SELECT 1 FROM conversations WHERE id = NEW.parent_id) IS NULL
      THEN RAISE(ABORT, 'parent conversation does not exist')
  END;
END;

-- ── tasks ─────────────────────────────────────────────────────────────────
CREATE TABLE tasks (
  id                TEXT PRIMARY KEY,        -- ULID
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  lane_id           TEXT,
  status            TEXT NOT NULL DEFAULT 'now'
                      CHECK (status IN ('now','later','done','dropped')),
  title             TEXT NOT NULL,
  body              TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);

-- ── decisions (append-only) ───────────────────────────────────────────────
-- Immutable log: corrections are new rows pointing at supersedes_id. Provenance
-- pointers are plain (no FK action) so they never trigger an UPDATE that the
-- append-only guard would abort. project_id keeps a NO-ACTION FK.
CREATE TABLE decisions (
  id                TEXT PRIMARY KEY,        -- ULID
  project_id        TEXT NOT NULL REFERENCES projects(id),
  conversation_id   TEXT,
  source_message_id TEXT,
  supersedes_id     TEXT REFERENCES decisions(id),
  text              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_decisions_project ON decisions(project_id);

CREATE TRIGGER decisions_no_update
BEFORE UPDATE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only; insert a superseding row');
END;
CREATE TRIGGER decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only; they cannot be deleted');
END;

-- ── memory_entries ────────────────────────────────────────────────────────
CREATE TABLE memory_entries (
  id                TEXT PRIMARY KEY,        -- ULID
  scope             TEXT NOT NULL CHECK (scope IN ('user','project')),
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  content           TEXT NOT NULL,
  char_count        INTEGER GENERATED ALWAYS AS (length(content)) VIRTUAL,
  source            TEXT,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (length(content) <= 4000),
  CHECK (
    (scope = 'project' AND project_id IS NOT NULL) OR
    (scope = 'user'    AND project_id IS NULL)
  )
);
CREATE INDEX idx_memory_scope_project ON memory_entries(scope, project_id);

-- ── lanes ─────────────────────────────────────────────────────────────────
CREATE TABLE lanes (
  id              TEXT PRIMARY KEY,          -- ULID (== protocol laneId)
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'spawned'
                    CHECK (status IN ('spawned','running','merging','completed','aborted')),
  mandate_json    TEXT NOT NULL,             -- a protocol LaneMandate document
  budget_json     TEXT,
  merge_json      TEXT,                       -- a protocol MergeReport document, once merged
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_lanes_conversation ON lanes(conversation_id);

-- ── accounts (no secrets — secret_ref names an entry in the secrets file) ──
CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,            -- ULID
  provider      TEXT NOT NULL,
  label         TEXT,
  auth_mode     TEXT NOT NULL
                  CHECK (auth_mode IN ('api_key','subscription_cli','local_endpoint','oauth')),
  secret_ref    TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (provider, label),
  -- secret_ref must be an ENV-NAME (^[A-Z][A-Z0-9_]*$), never a secret value.
  CHECK (
    secret_ref IS NULL OR (
      secret_ref NOT GLOB '*[^A-Z0-9_]*' AND substr(secret_ref, 1, 1) GLOB '[A-Z]'
    )
  )
);

-- ── connectors (no secrets in config_json) ────────────────────────────────
CREATE TABLE connectors (
  id            TEXT PRIMARY KEY,            -- ULID
  slug          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'needs_setup'
                  CHECK (status IN ('needs_setup','ready','error','disabled')),
  manifest_json TEXT,
  config_json   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- ── settings (non-secret config values only) ──────────────────────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- tripwire: secrets do not belong here (use accounts.secret_ref).
  CHECK (
    lower(key) NOT LIKE '%secret%'  AND
    lower(key) NOT LIKE '%api_key%' AND
    lower(key) NOT LIKE '%apikey%'  AND
    lower(key) NOT LIKE '%token%'   AND
    lower(key) NOT LIKE '%password%'
  )
);
