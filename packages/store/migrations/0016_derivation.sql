-- 0016 (ADR-0045): why does this card exist?
--
-- "פתיחת כרטיס תציג לא רק פרטים, אלא גם למה הוא קיים, מאיזו מטרה, מגבלה,
--  החלטה או מסמך הוא נגזר."
--
-- A task that nobody can trace back to a reason is how a board fills up with work
-- nobody remembers agreeing to. `derived_from_json` is the trace: what this card
-- came out of — a decision, a constraint, a milestone, a risk, or a source document.
ALTER TABLE tasks ADD COLUMN derived_from_json TEXT NOT NULL DEFAULT '[]';
