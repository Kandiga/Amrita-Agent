-- ADR-0053: durable at-most-once lane creation.
-- Nullable preserves every pre-0053 lane and replay payload unchanged.
ALTER TABLE lanes ADD COLUMN idempotency_key TEXT;
ALTER TABLE lanes ADD COLUMN group_id TEXT;
ALTER TABLE lanes ADD COLUMN role TEXT CHECK (role IS NULL OR role IN ('build', 'qa', 'compare'));
ALTER TABLE lanes ADD COLUMN verifies_lane_id TEXT;

CREATE UNIQUE INDEX idx_lanes_idempotency
  ON lanes(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_lanes_group ON lanes(group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_lanes_verifies_lane
  ON lanes(verifies_lane_id)
  WHERE verifies_lane_id IS NOT NULL;
