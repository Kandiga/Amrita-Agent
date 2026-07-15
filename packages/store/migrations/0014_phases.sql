-- 0014 (ADR-0045): phases — the board is born from the project, not a template.
--
-- From the product brief (voice, file 04):
--   "בלוח, העמודות יכולות להתאים לשלבי הפרויקט ולא להיות קבועות לכל העולם."
-- and (file 02):
--   "כאשר יש מספיק בסיס, אמריטה מציעה להפעיל את הפרויקט. רק אחרי אישור שלך היא
--    יוצרת אבני דרך, שלבים ומשימות ראשונות. כך הלוח לא מופיע מתוך תבנית מוכנה.
--    הוא נולד מההקשר הספציפי."
--
-- Until now the board's columns were hard-coded (now / waiting / later / done) —
-- the same four for a festival, a product launch and a house move. A phase is the
-- project's OWN shape: "Permits", "Vendors", "Load-in", "The day itself".
--
-- A phase is NOT a milestone. A milestone is a dated outcome you either hit or
-- miss; a phase is a stretch of work that tasks live inside. They coexist: a phase
-- can contain several milestones.

CREATE TABLE phases (
  id          TEXT PRIMARY KEY,               -- ULID
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL CHECK (length(title) <= 120),
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','active','done','dropped')),
  -- The same lexicographic fractional index the board uses for cards, so phases
  -- can be reordered with ONE event and no renumbering of siblings.
  order_key   TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_phases_project ON phases(project_id, status, order_key);

-- A task belongs to at most one phase. Trigger-enforced rather than an FK clause,
-- so the down migration can DROP COLUMN (the ADR-0018 `milestone_id` pattern).
ALTER TABLE tasks ADD COLUMN phase_id TEXT;
CREATE INDEX idx_tasks_phase ON tasks(phase_id);

CREATE TRIGGER tasks_phase_ins
BEFORE INSERT ON tasks
WHEN NEW.phase_id IS NOT NULL
  AND (SELECT COUNT(*) FROM phases WHERE id = NEW.phase_id) = 0
BEGIN
  SELECT RAISE(ABORT, 'phase_id must reference an existing phase');
END;

CREATE TRIGGER tasks_phase_upd
BEFORE UPDATE OF phase_id ON tasks
WHEN NEW.phase_id IS NOT NULL
  AND (SELECT COUNT(*) FROM phases WHERE id = NEW.phase_id) = 0
BEGIN
  SELECT RAISE(ABORT, 'phase_id must reference an existing phase');
END;

-- Activation (ADR-0045). A project is a conversation until you ACTIVATE it; only
-- then does Amrita create phases, milestones and the first tasks. Recorded on the
-- project so the UI can tell "not started yet" from "empty board", which are very
-- different things and were indistinguishable before.
ALTER TABLE projects ADD COLUMN activated_at TEXT;
