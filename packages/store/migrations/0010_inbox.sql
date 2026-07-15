-- 0010 (ADR-0044): the Inbox — the ONE triage queue.
--
-- Everything an agent (the Scribe), a lane (a merge report) or a human (quick
-- capture) proposes lands here and becomes project truth only by an explicit
-- triage. This is the aggregate that closes the agent→domain loop: before it,
-- the chat agent had no way to write project state at all, so 298 live events
-- had produced zero tasks, milestones, risks and questions.
--
-- The two CHECKs are the ADR-0018 house rule — nothing leaves the queue
-- silently. A promotion must NAME what it became; a dismissal must give a
-- reason. Both are enforced here, at the SQL layer, not only in the caller.

CREATE TABLE inbox_items (
  id                TEXT PRIMARY KEY,               -- ULID
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id   TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  origin            TEXT NOT NULL
                      CHECK (origin IN ('user','agent','lane','system')),
  text              TEXT NOT NULL CHECK (length(text) <= 2000),
  -- what it LOOKS like, and the payload for the target command. Both nullable:
  -- a human quick-capture is often just a line of text with no suggestion.
  suggested_kind    TEXT CHECK (suggested_kind IS NULL OR suggested_kind IN
                      ('task','decision','risk','question','milestone','memory')),
  suggested_json    TEXT,
  rationale         TEXT CHECK (rationale IS NULL OR length(rationale) <= 1000),
  confidence        TEXT CHECK (confidence IS NULL OR confidence IN ('low','medium','high')),
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','triaged','dismissed')),
  promoted_kind     TEXT CHECK (promoted_kind IS NULL OR promoted_kind IN
                      ('task','decision','risk','question','milestone','memory')),
  promoted_id       TEXT,
  dismiss_reason    TEXT CHECK (dismiss_reason IS NULL OR length(dismiss_reason) <= 500),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,

  -- no silent promotion: a triaged item must say what it became
  CHECK (status != 'triaged' OR (promoted_kind IS NOT NULL AND promoted_id IS NOT NULL)),
  -- no silent dismissal: exactly the question.dropped / risk.dropped invariant
  CHECK (status != 'dismissed' OR dismiss_reason IS NOT NULL)
);

-- the triage queue read: pending items for a project, oldest first
CREATE INDEX idx_inbox_project_status ON inbox_items(project_id, status, created_at);
