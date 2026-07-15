-- 0011 (ADR-0044): the charter — what the video calls "constraints as fuel".
--
-- The brief already held goal / audience / success criteria / scope / no-scope.
-- What was missing is exactly what makes a plan accountable: the money and dates
-- it must live within, who is allowed to approve what, and an explicit finish
-- line. Without these the agent cannot answer "which constraint is most likely
-- to break this project?" — the question the whole method turns on.
--
-- Additive columns on the existing aggregate, NOT a new table: the brief is a
-- full-document upsert (ADR-0018), so extending it is replay-safe and the down
-- migration is a plain DROP COLUMN (the `tasks.milestone_id` pattern).

-- The explicit definition of done. "Done means [specific finish line]."
ALTER TABLE project_briefs ADD COLUMN finish_line TEXT;

-- [{kind: budget|date|resource|policy, text, hard: bool}]
-- `hard` is the fixed-vs-negotiable boundary. Kept as JSON because a constraint
-- is a sentence with a flag, not a relational entity — it is never queried by
-- field, only read whole with the brief.
ALTER TABLE project_briefs ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '[]';

-- [{area, approver}] — who approves what. Free text on both sides: Amrita has no
-- user/contact table, and inventing one is a much larger decision.
ALTER TABLE project_briefs ADD COLUMN decision_rights_json TEXT NOT NULL DEFAULT '[]';
