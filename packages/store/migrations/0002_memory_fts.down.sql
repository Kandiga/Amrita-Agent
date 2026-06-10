-- Reverse of 0002_memory_fts.sql. Drop the sync triggers, then the FTS table
-- (which removes its shadow tables too).

DROP TRIGGER IF EXISTS memory_entries_au;
DROP TRIGGER IF EXISTS memory_entries_ad;
DROP TRIGGER IF EXISTS memory_entries_ai;
DROP TABLE IF EXISTS memory_entries_fts;
