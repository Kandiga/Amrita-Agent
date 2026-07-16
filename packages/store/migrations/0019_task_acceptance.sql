-- ADR-0055: evidence-based done — typed acceptance criteria + machine verification.
-- Nullable adds preserve every pre-0055 task row and replay payload unchanged.
ALTER TABLE tasks ADD COLUMN acceptance_json TEXT;
ALTER TABLE tasks ADD COLUMN verified_at TEXT;
ALTER TABLE tasks ADD COLUMN verification_json TEXT;
