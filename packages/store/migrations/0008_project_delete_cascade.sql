-- ADR-0038: project.delete is the single sanctioned destructive verb.
-- The decisions append-only invariant stays for normal operation; a delete is
-- permitted ONLY while the same transaction holds the cascade flag for that
-- exact project (settings key 'cascade.project.delete'). store.deleteProject
-- sets the flag, cascades, and clears it inside one transaction, so no other
-- code path can ever observe — or exploit — the open gate.
DROP TRIGGER decisions_no_delete;
CREATE TRIGGER decisions_no_delete
BEFORE DELETE ON decisions
WHEN COALESCE(
  (SELECT json_extract(value_json, '$') FROM settings WHERE key = 'cascade.project.delete'),
  ''
) <> OLD.project_id
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only; they cannot be deleted');
END;
