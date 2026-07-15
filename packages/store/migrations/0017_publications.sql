-- 0017 (ADR-0045): the public stakeholder hub.
--
-- What is durable is NOT the HTML — that is a deterministic function of project
-- state and is re-rendered on demand (the ADR-0020 preview model). What is durable
-- is the PUBLICATION: "content-hash H of project X is public, at slug S, since T."
--
-- The slug is opaque and high-entropy: it is not the project id, not the slug, not
-- anything guessable. Revoking sets `revoked_at` and deletes the bytes.
CREATE TABLE project_publications (
  project_id   TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  public_slug  TEXT NOT NULL UNIQUE CHECK (length(public_slug) BETWEEN 16 AND 64),
  content_hash TEXT NOT NULL CHECK (length(content_hash) <= 64),
  published_at TEXT NOT NULL,
  revoked_at   TEXT
);
