-- Reverse of 0004_companion.sql. Drop triggers/indexes on tasks.milestone_id
-- before the column so ALTER TABLE ... DROP COLUMN is legal.

DROP INDEX IF EXISTS idx_events_project_ts;

DROP TRIGGER IF EXISTS tasks_milestone_upd;
DROP TRIGGER IF EXISTS tasks_milestone_ins;
DROP INDEX IF EXISTS idx_tasks_milestone;
ALTER TABLE tasks DROP COLUMN milestone_id;

DROP INDEX IF EXISTS idx_milestones_project;
DROP TABLE IF EXISTS milestones;

DROP TRIGGER IF EXISTS risks_decision_upd;
DROP TRIGGER IF EXISTS risks_decision_ins;
DROP INDEX IF EXISTS idx_risks_project_status;
DROP TABLE IF EXISTS risks;

DROP TRIGGER IF EXISTS open_questions_decision_upd;
DROP TRIGGER IF EXISTS open_questions_decision_ins;
DROP INDEX IF EXISTS idx_questions_project_status;
DROP TABLE IF EXISTS open_questions;

DROP TABLE IF EXISTS project_briefs;
