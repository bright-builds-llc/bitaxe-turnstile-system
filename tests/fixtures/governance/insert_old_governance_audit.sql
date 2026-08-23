INSERT INTO gate_authority.governance_audit_events (
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
    '00000000-0000-4000-8000-000000000090',
    'retention_planned',
    '00000000-0000-4000-8000-000000000091',
    NULL,
    100,
    '{"records":1}'::JSONB,
    5,
    'completed',
    NULL
)
