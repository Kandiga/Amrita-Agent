-- Amrita v2 store — full-text search over memory_entries (migration 0002).
-- External-content FTS5 over memory_entries.content (a real column, ≤4000),
-- kept in sync by triggers. Mirrors the messages_fts design (0000). The SQL is
-- the source of truth; Drizzle cannot express FTS tables/triggers (ADR-0008).
-- Reversible by 0002_memory_fts.down.sql.

CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
  content,
  content='memory_entries',
  content_rowid='rowid'
);

-- Index any rows that already exist (no-op on a fresh DB).
INSERT INTO memory_entries_fts(memory_entries_fts) VALUES ('rebuild');

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_entries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_entries_fts(memory_entries_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memory_entries_fts(rowid, content) VALUES (new.rowid, new.content);
END;
