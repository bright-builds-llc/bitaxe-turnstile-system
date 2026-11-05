-- Durable per-key Work Lease Authority sequence (ADR-0093, ADR-0106). The allocator
-- stops at the BIGINT ceiling instead of wrapping.
CREATE TABLE gate_authority.work_lease_authorization_sequences (
    key_id TEXT PRIMARY KEY CHECK (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
    last_sequence BIGINT NOT NULL CHECK (last_sequence >= 1)
);
