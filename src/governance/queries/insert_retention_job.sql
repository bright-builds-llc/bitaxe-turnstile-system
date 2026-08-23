INSERT INTO governance_retention_jobs (
    job_id,
    manifest_digest,
    as_of_unix_seconds,
    policy,
    status,
    cursor,
    eligible_items,
    created_at_unix_seconds
)
VALUES (
    $1,
    $2,
    $3,
    $4,
    'planned',
    0,
    $5,
    FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
)
