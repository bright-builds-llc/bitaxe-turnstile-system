INSERT INTO gate_authority.governance_export_jobs (
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
    '00000000-0000-4000-8000-000000000201',
    100,
    'ready',
    0,
    0,
    'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    '{}'::JSONB,
    100
)
