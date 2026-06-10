-- Amrita v2 store — channel pairings (migration 0003).
-- Links an external channel identity (e.g. a Telegram numeric user id) to an
-- Amrita project + conversation via a short pairing code. This is local linking
-- *configuration*, written directly (not event-sourced), like account.secret_ref
-- (ADR-0008/0013). It holds NO secrets — `code` is a low-sensitivity pairing
-- token, never an API key or bot token.

CREATE TABLE channel_pairings (
  code            TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  claimed_by      TEXT,           -- external user id (string), NULL until claimed
  created_at      TEXT NOT NULL,
  claimed_at      TEXT
);
CREATE INDEX idx_channel_pairings_claim ON channel_pairings(channel, claimed_by);
