-- Reverse of 0006_task_external_ref.sql.
DROP INDEX IF EXISTS uq_tasks_project_external_ref;
ALTER TABLE tasks DROP COLUMN external_ref;
