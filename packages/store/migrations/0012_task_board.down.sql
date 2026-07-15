DROP INDEX IF EXISTS idx_tasks_board;
ALTER TABLE tasks DROP COLUMN blocked_reason;
ALTER TABLE tasks DROP COLUMN order_key;
ALTER TABLE tasks DROP COLUMN priority;
ALTER TABLE tasks DROP COLUMN due_date;
ALTER TABLE tasks DROP COLUMN owner;
