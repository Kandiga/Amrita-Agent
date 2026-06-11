-- Amrita v2 store — Project Companion Core (migration 0004, ADR-0018).
-- Brief / open questions / risks / milestones + task→milestone linkage and a
-- project-timeline index. Invariants live here (CHECKs + triggers); the event
-- protocol mirrors them. Reversible by 0004_companion.down.sql.

-- ── project brief (one upsert-document row per project) ───────────────────
CREATE TABLE project_briefs (
  project_id            TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  goal                  TEXT NOT NULL CHECK (length(goal) <= 2000),
  audience              TEXT,
  success_criteria_json TEXT NOT NULL DEFAULT '[]',
  scope_json            TEXT NOT NULL DEFAULT '[]',
  no_scope_json         TEXT NOT NULL DEFAULT '[]',
  source_message_id     TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- ── open questions ─────────────────────────────────────────────────────────
-- Lifecycle invariants: resolving needs evidence (a note or a decision link);
-- dropping needs a reason. No silent closures.
CREATE TABLE open_questions (
  id                      TEXT PRIMARY KEY,        -- ULID
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id         TEXT,
  source_message_id       TEXT,
  text                    TEXT NOT NULL CHECK (length(text) <= 2000),
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','resolved','dropped')),
  resolution              TEXT,
  resolved_by_decision_id TEXT,
  drop_reason             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (status != 'resolved' OR resolution IS NOT NULL OR resolved_by_decision_id IS NOT NULL),
  CHECK (status != 'dropped' OR drop_reason IS NOT NULL)
);
CREATE INDEX idx_questions_project_status ON open_questions(project_id, status);

-- A claimed decision link must point at a real decision (insert + update).
CREATE TRIGGER open_questions_decision_ins
BEFORE INSERT ON open_questions
WHEN NEW.resolved_by_decision_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT 1 FROM decisions WHERE id = NEW.resolved_by_decision_id) IS NULL
      THEN RAISE(ABORT, 'resolved_by_decision_id does not reference a decision')
  END;
END;
CREATE TRIGGER open_questions_decision_upd
BEFORE UPDATE OF resolved_by_decision_id ON open_questions
WHEN NEW.resolved_by_decision_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT 1 FROM decisions WHERE id = NEW.resolved_by_decision_id) IS NULL
      THEN RAISE(ABORT, 'resolved_by_decision_id does not reference a decision')
  END;
END;

-- ── risks (same lifecycle as questions + tiny optional severity) ──────────
CREATE TABLE risks (
  id                      TEXT PRIMARY KEY,        -- ULID
  project_id              TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id         TEXT,
  source_message_id       TEXT,
  text                    TEXT NOT NULL CHECK (length(text) <= 2000),
  severity                TEXT CHECK (severity IS NULL OR severity IN ('low','medium','high')),
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','resolved','dropped')),
  resolution              TEXT,
  resolved_by_decision_id TEXT,
  drop_reason             TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (status != 'resolved' OR resolution IS NOT NULL OR resolved_by_decision_id IS NOT NULL),
  CHECK (status != 'dropped' OR drop_reason IS NOT NULL)
);
CREATE INDEX idx_risks_project_status ON risks(project_id, status);

CREATE TRIGGER risks_decision_ins
BEFORE INSERT ON risks
WHEN NEW.resolved_by_decision_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT 1 FROM decisions WHERE id = NEW.resolved_by_decision_id) IS NULL
      THEN RAISE(ABORT, 'resolved_by_decision_id does not reference a decision')
  END;
END;
CREATE TRIGGER risks_decision_upd
BEFORE UPDATE OF resolved_by_decision_id ON risks
WHEN NEW.resolved_by_decision_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT 1 FROM decisions WHERE id = NEW.resolved_by_decision_id) IS NULL
      THEN RAISE(ABORT, 'resolved_by_decision_id does not reference a decision')
  END;
END;

-- ── milestones ─────────────────────────────────────────────────────────────
CREATE TABLE milestones (
  id          TEXT PRIMARY KEY,                    -- ULID
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) <= 300),
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','active','done','dropped')),
  target_date TEXT CHECK (target_date IS NULL OR target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_milestones_project ON milestones(project_id, status);

-- ── task → milestone linkage ───────────────────────────────────────────────
-- Trigger-enforced (no FK clause, so the down path can DROP COLUMN — the
-- conversations.parent_id pattern from ADR-0003).
ALTER TABLE tasks ADD COLUMN milestone_id TEXT;
CREATE INDEX idx_tasks_milestone ON tasks(milestone_id);

CREATE TRIGGER tasks_milestone_ins
BEFORE INSERT ON tasks
WHEN NEW.milestone_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT 1 FROM milestones WHERE id = NEW.milestone_id) IS NULL
      THEN RAISE(ABORT, 'milestone does not exist')
  END;
END;
CREATE TRIGGER tasks_milestone_upd
BEFORE UPDATE OF milestone_id ON tasks
WHEN NEW.milestone_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT 1 FROM milestones WHERE id = NEW.milestone_id) IS NULL
      THEN RAISE(ABORT, 'milestone does not exist')
  END;
END;

-- ── project timeline (derived from the event log; just an index) ──────────
CREATE INDEX idx_events_project_ts ON events(project_id, ts);
