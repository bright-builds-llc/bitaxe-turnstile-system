-- Accepted work is judged against the lease's first reading, not the last Start or
-- Renew reading: delivery is neither prompt nor ordered, and event and share
-- deduplication already stop a second credit. Meaningful only while leased.
ALTER TABLE gate_authority.work_sessions
    ADD COLUMN lease_started_at_monotonic_milliseconds BIGINT CHECK (
        lease_started_at_monotonic_milliseconds IS NULL
        OR lease_started_at_monotonic_milliseconds >= 0
    );

UPDATE gate_authority.work_sessions
SET lease_started_at_monotonic_milliseconds = last_monotonic_milliseconds
WHERE lifecycle_state = 'leased';
