-- Amrita v2 store — task external provenance (migration 0006, ADR-0022).
-- `external_ref` links a task to its origin in an external system, e.g.
-- `github:owner/repo#123`. The partial unique index makes import idempotency a
-- database guarantee: one task per (project, external ref). Reversible by
-- 0006_task_external_ref.down.sql.

ALTER TABLE tasks ADD COLUMN external_ref TEXT CHECK (external_ref IS NULL OR length(external_ref) <= 200);

CREATE UNIQUE INDEX uq_tasks_project_external_ref
  ON tasks (project_id, external_ref)
  WHERE external_ref IS NOT NULL;
