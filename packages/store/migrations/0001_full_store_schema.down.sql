-- Reverse of 0001_full_store_schema.sql. Drop dependents before the parent
-- column so ALTER TABLE ... DROP COLUMN is legal (no index/trigger/FK on it).

-- decisions append-only guards
DROP TRIGGER IF EXISTS decisions_no_delete;
DROP TRIGGER IF EXISTS decisions_no_update;

-- conversation lineage trigger + index (must go before dropping the column)
DROP TRIGGER IF EXISTS conversations_parent_upd;
DROP TRIGGER IF EXISTS conversations_parent_ins;
DROP INDEX IF EXISTS idx_conversations_parent;

-- entity tables (order is irrelevant — none of these are referenced by 0000)
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS connectors;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS lanes;
DROP TABLE IF EXISTS memory_entries;
DROP TABLE IF EXISTS decisions;
DROP TABLE IF EXISTS tasks;

-- finally, remove the lineage column
ALTER TABLE conversations DROP COLUMN parent_id;
