INSERT INTO gate_authority.governance_export_jobs (
    export_id,
    snapshot_cutoff_unix_seconds,
    status,
    total_items,
    total_bytes,
    content_sha256,
    counts,
    created_at_unix_seconds,
    completed_at_unix_seconds
)
VALUES (
    '00000000-0000-4000-8000-000000000202',
    100,
    'completed',
    0,
    0,
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '{}'::JSONB,
    100,
    NULL
)
