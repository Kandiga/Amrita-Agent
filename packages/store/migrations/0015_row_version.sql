-- 0015 (ADR-0045): a real version token for optimistic locking.
--
-- 0013/0014 shipped the conflict guard keyed on `updated_at`. That was WRONG, and
-- a test caught it: `updated_at` is an ISO timestamp with millisecond resolution,
-- so two writes landing in the same millisecond carry the SAME token — and a stale
-- write would sail straight through the guard that exists to stop it.
--
-- A monotonic counter cannot collide. It is also deterministic under replay (it is
-- just "how many updates have been applied to this row"), so `rebuildProjections`
-- reproduces it exactly.
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_briefs ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
