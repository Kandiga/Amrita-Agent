-- Down for 0007: restore the pre-whatsapp channel CHECK.
-- Refuses (by CHECK violation) if whatsapp events exist — reversible only when
-- no data would be silently invalidated; never drops rows behind your back.

CREATE TABLE events_old (
  id              TEXT PRIMARY KEY,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  lane_id         TEXT,
  origin          TEXT NOT NULL CHECK (origin IN ('user','agent','lane','system')),
  channel         TEXT CHECK (channel IN ('web','telegram','cli','api')),
  type            TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

INSERT INTO events_old
  SELECT id, seq, ts, project_id, conversation_id, turn_id, lane_id, origin, channel, type, payload_json
  FROM events;

DROP TABLE events;
ALTER TABLE events_old RENAME TO events;

CREATE INDEX idx_events_conversation_seq ON events(conversation_id, seq);
CREATE INDEX idx_events_type ON events(type);
