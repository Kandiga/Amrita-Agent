DROP TRIGGER IF EXISTS tasks_phase_upd;
DROP TRIGGER IF EXISTS tasks_phase_ins;
DROP INDEX IF EXISTS idx_tasks_phase;
ALTER TABLE tasks DROP COLUMN phase_id;
DROP INDEX IF EXISTS idx_phases_project;
DROP TABLE IF EXISTS phases;
ALTER TABLE projects DROP COLUMN activated_at;
