-- 0012 (ADR-0044): the fields a real board needs.
--
-- The task row had status / title / body / milestone / externalRef and nothing
-- else — no owner, no due date, no priority, no ordering, no way to say "this is
-- blocked". Interestingly the VIDEO's board has none of these either (its cards
-- carry metadata as prose inside the title: "Harbor Savings Bank sponsorship
-- signed ($5,000, paid)"). Copying that would be a downgrade; these are typed.

-- Free text. Amrita has NO user/contact table, and inventing one is a much
-- larger decision (accounts, permissions, identity) — a future ADR. Free-text
-- owner unblocks the board today and feeds the `missing-owner` knowledge gap the
-- Brain harness already knows how to detect.
ALTER TABLE tasks ADD COLUMN owner TEXT;

ALTER TABLE tasks ADD COLUMN due_date TEXT
  CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

ALTER TABLE tasks ADD COLUMN priority TEXT
  CHECK (priority IS NULL OR priority IN ('low','normal','high'));

-- A lexicographic FRACTIONAL INDEX, not an integer position. Dragging a card
-- between two others computes a key strictly between their keys, so a move is
-- ONE `task.updated` event touching ONE row — no re-indexing of siblings, no
-- write amplification, and two concurrent drags cannot corrupt each other's
-- ordering (worst case they tie, and the id breaks the tie deterministically).
ALTER TABLE tasks ADD COLUMN order_key TEXT;

-- The "Waiting" column, WITHOUT touching taskStatusSchema.
--
-- SQLite cannot alter a CHECK constraint: adding 'blocked' to the status enum
-- would require rebuilding the whole tasks table — which is exactly what
-- 0007_whatsapp_channel did to `events`, and it silently LOST an index in the
-- process (see 0009). A nullable reason column expresses the same board column
-- at zero migration risk, and carries strictly more information: not just THAT
-- it is blocked, but on what.
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;

-- The board read: a project's tasks, grouped by column, in order.
CREATE INDEX idx_tasks_board ON tasks(project_id, status, order_key);
