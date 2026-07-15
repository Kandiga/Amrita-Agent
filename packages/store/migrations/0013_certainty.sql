-- 0013 (ADR-0045): certainty — never mix fact with hypothesis.
--
-- From the product brief (voice, file 02):
--   "כל תשובה תישמר עם מקור. אתה אמרת אותה, היא מופיעה במסמך,
--    או שהיא מוסקה ודורשת אישור. כך אמריטה לעולם לא תערבב עובדה עם השערה."
--
-- We already record WHERE a fact came from (`source_message_id`). What was missing
-- is HOW SURE we are of it:
--
--   stated     — the operator said it. The strongest kind of truth this system has.
--   documented — it came from a source document / an external system (e.g. GitHub).
--   inferred   — Amrita worked it out. It is a HYPOTHESIS until a human confirms it.
--
-- `inferred` is not a lesser fact, it is a DIFFERENT KIND of thing, and the UI must
-- never render it as though the operator had said it. Anything the Scribe proposes
-- already passes through the Inbox for approval — this column is what keeps the
-- distinction visible AFTER the promotion, not just before it.

ALTER TABLE tasks ADD COLUMN certainty TEXT
  CHECK (certainty IS NULL OR certainty IN ('stated','documented','inferred'));

ALTER TABLE risks ADD COLUMN certainty TEXT
  CHECK (certainty IS NULL OR certainty IN ('stated','documented','inferred'));

ALTER TABLE open_questions ADD COLUMN certainty TEXT
  CHECK (certainty IS NULL OR certainty IN ('stated','documented','inferred'));

-- Per-FIELD certainty for the charter, so the UI can mark each area of the charter
-- with "ודאות, חוסר וסתירה" (certain / missing / contradictory) as the brief asks.
-- A JSON map (`{"goal":"stated","finishLine":"inferred"}`) rather than a column per
-- field: the charter's shape is still moving, and the brief is already a
-- full-document upsert, so this stays replay-exact.
ALTER TABLE project_briefs ADD COLUMN certainty_json TEXT NOT NULL DEFAULT '{}';
