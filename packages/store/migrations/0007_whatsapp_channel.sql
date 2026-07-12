-- 0007 (ADR-0037): `whatsapp` joins the events channel CHECK.
-- SQLite cannot alter a CHECK, so the events table is rebuilt in place.
-- Data, the (conversation_id, seq) uniqueness, and both indexes are preserved.

CREATE TABLE events_new (
  id              TEXT PRIMARY KEY,        -- ULID
  seq             INTEGER NOT NULL,        -- per-conversation monotonic
  ts              TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  lane_id         TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('user','agent','lane','system')),
  channel         TEXT CHECK (channel IN ('web','telegram','whatsapp','cli','api')),
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

INSERT INTO events_new
  SELECT id, seq, ts, project_id, conversation_id, turn_id, lane_id, origin, channel, type, payload_json
  FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_conversation_seq ON events(conversation_id, seq);
CREATE INDEX idx_events_type ON events(type);
