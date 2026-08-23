INSERT INTO governance_audit_events (
    event_id,
    event_type,
    operation_id,
    manifest_digest,
    occurred_at_unix_seconds,
    counts,
    duration_milliseconds,
    outcome,
    error_category
)
VALUES (
    $1,
    $2,
    $3,
    $4,
    FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT,
    $5,
    $6,
    $7,
    $8
)
