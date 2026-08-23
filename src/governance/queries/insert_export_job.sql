INSERT INTO governance_export_jobs (
    export_id,
    snapshot_cutoff_unix_seconds,
    status,
    total_items,
    total_bytes,
    content_sha256,
    counts,
    created_at_unix_seconds
)
VALUES (
    $1,
    $2,
    'ready',
    $3,
    $4,
    $5,
    $6,
    FLOOR(EXTRACT(EPOCH FROM NOW()))::BIGINT
)
