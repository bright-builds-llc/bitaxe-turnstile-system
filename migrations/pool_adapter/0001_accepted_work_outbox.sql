CREATE SCHEMA IF NOT EXISTS pool_adapter;

CREATE TABLE pool_adapter.stratum_sessions (
    session_id TEXT PRIMARY KEY CHECK (session_id ~ '^session_[A-Za-z0-9_-]{1,128}$'),
    username TEXT NOT NULL UNIQUE CHECK (username ~ '^bwg_[A-Za-z0-9_-]{22}$'),
    secret_verifier TEXT NOT NULL CHECK (secret_verifier ~ '^[A-Za-z0-9_-]{43}$'),
    issued_at_unix_seconds BIGINT NOT NULL CHECK (issued_at_unix_seconds > 0),
    expires_at_unix_seconds BIGINT NOT NULL CHECK (expires_at_unix_seconds > 0),
    lease_id UUID NOT NULL,
    continuity_id TEXT NOT NULL,
    last_monotonic_milliseconds BIGINT NOT NULL CHECK (last_monotonic_milliseconds >= 0),
    renew_at_monotonic_milliseconds BIGINT NOT NULL CHECK (renew_at_monotonic_milliseconds > 0),
    lease_expires_at_monotonic_milliseconds BIGINT NOT NULL CHECK (
        lease_expires_at_monotonic_milliseconds >= renew_at_monotonic_milliseconds
    )
);

CREATE TABLE pool_adapter.stratum_connections (
    connection_id UUID PRIMARY KEY,
    session_id TEXT REFERENCES pool_adapter.stratum_sessions(session_id),
    extranonce1 TEXT NOT NULL UNIQUE CHECK (extranonce1 ~ '^[0-9A-Fa-f]{2,64}$'),
    reserved_at_unix_seconds BIGINT NOT NULL CHECK (reserved_at_unix_seconds > 0)
);

CREATE TABLE pool_adapter.accepted_work_outbox (
    event_id TEXT PRIMARY KEY CHECK (event_id ~ '^event_[A-Za-z0-9_-]{1,128}$'),
    session_id TEXT NOT NULL CHECK (session_id ~ '^session_[A-Za-z0-9_-]{1,128}$'),
    lease_id UUID NOT NULL,
    continuity_id TEXT NOT NULL,
    last_monotonic_milliseconds BIGINT NOT NULL CHECK (last_monotonic_milliseconds >= 0),
    renew_at_monotonic_milliseconds BIGINT NOT NULL CHECK (renew_at_monotonic_milliseconds > 0),
    lease_expires_at_monotonic_milliseconds BIGINT NOT NULL CHECK (
        lease_expires_at_monotonic_milliseconds >= renew_at_monotonic_milliseconds
    ),
    assigned_target BYTEA NOT NULL CHECK (OCTET_LENGTH(assigned_target) = 32),
    received_at_unix_seconds BIGINT NOT NULL CHECK (received_at_unix_seconds > 0),
    share_fingerprint TEXT NOT NULL CHECK (
        share_fingerprint ~ '^share_[A-Za-z0-9_-]{1,128}$'
    ),
    network_target_outcome TEXT NOT NULL CHECK (
        network_target_outcome IN ('below_network_target', 'network_target_met')
    ),
    worker_response TEXT NOT NULL,
    delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (
        delivery_state IN ('pending', 'acknowledged')
    ),
    delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
    delivery_owner TEXT,
    delivery_lease_expires_at_unix_seconds BIGINT,
    acknowledged_at_unix_seconds BIGINT,
    CHECK (
        (
            delivery_state = 'pending'
            AND acknowledged_at_unix_seconds IS NULL
            AND (
                (delivery_owner IS NULL AND delivery_lease_expires_at_unix_seconds IS NULL)
                OR (
                    delivery_owner IS NOT NULL
                    AND delivery_lease_expires_at_unix_seconds IS NOT NULL
                )
            )
        )
        OR (
            delivery_state = 'acknowledged'
            AND acknowledged_at_unix_seconds IS NOT NULL
            AND delivery_owner IS NULL
            AND delivery_lease_expires_at_unix_seconds IS NULL
        )
    )
);

CREATE INDEX accepted_work_pending_delivery
    ON pool_adapter.accepted_work_outbox (
        delivery_state,
        delivery_lease_expires_at_unix_seconds,
        received_at_unix_seconds,
        event_id
    );
