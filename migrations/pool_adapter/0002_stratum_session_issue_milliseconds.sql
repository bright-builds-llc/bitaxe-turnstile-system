ALTER TABLE pool_adapter.stratum_sessions
    ADD COLUMN issued_at_unix_milliseconds BIGINT;

UPDATE pool_adapter.stratum_sessions
SET issued_at_unix_milliseconds = issued_at_unix_seconds * 1000;

ALTER TABLE pool_adapter.stratum_sessions
    ALTER COLUMN issued_at_unix_milliseconds SET NOT NULL,
    ADD CONSTRAINT stratum_sessions_issued_at_milliseconds_matches_seconds CHECK (
        issued_at_unix_milliseconds / 1000 = issued_at_unix_seconds
    );
