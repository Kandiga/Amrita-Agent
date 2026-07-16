DROP INDEX idx_lanes_verifies_lane;
DROP INDEX idx_lanes_group;
DROP INDEX idx_lanes_idempotency;
ALTER TABLE lanes DROP COLUMN verifies_lane_id;
ALTER TABLE lanes DROP COLUMN role;
ALTER TABLE lanes DROP COLUMN group_id;
ALTER TABLE lanes DROP COLUMN idempotency_key;
