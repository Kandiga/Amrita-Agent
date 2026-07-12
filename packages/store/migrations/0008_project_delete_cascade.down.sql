DROP TRIGGER decisions_no_delete;
CREATE TRIGGER decisions_no_delete
BEFORE DELETE ON decisions
BEGIN
  SELECT RAISE(ABORT, 'decisions are append-only; they cannot be deleted');
END;
