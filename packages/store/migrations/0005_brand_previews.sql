-- Amrita v2 store — brand memory B1 + preview approvals (migration 0005, ADR-0020).
-- One brand document per project; durable approvals for deterministic surface
-- previews keyed by (project, preview id). No secrets, no invented data: a
-- missing row IS the honest empty state. Reversible by 0005_brand_previews.down.sql.

CREATE TABLE project_brands (
  project_id        TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  name              TEXT CHECK (name IS NULL OR length(name) <= 200),
  audience          TEXT CHECK (audience IS NULL OR length(audience) <= 500),
  tone              TEXT CHECK (tone IS NULL OR length(tone) <= 500),
  style_notes_json  TEXT NOT NULL DEFAULT '[]',
  palette_json      TEXT NOT NULL DEFAULT '[]',
  typography        TEXT CHECK (typography IS NULL OR length(typography) <= 500),
  do_not_use_json   TEXT NOT NULL DEFAULT '[]',
  source_message_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE preview_approvals (
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  preview_id        TEXT NOT NULL CHECK (length(preview_id) <= 120),
  content_hash      TEXT NOT NULL CHECK (length(content_hash) <= 64),
  source_message_id TEXT,
  approved_at       TEXT NOT NULL,
  PRIMARY KEY (project_id, preview_id)
);
