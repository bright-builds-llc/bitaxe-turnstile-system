INSERT INTO gate_authority.work_challenges (
    challenge_id,
    descriptor,
    gate_pass_claims_seed,
    work_requirement,
    verified_progress,
    satisfied,
    expires_at_unix_seconds,
    terminal_at_unix_seconds
)
VALUES (
    'challenge_after_export_snapshot',
    '{"prohibited":"post-snapshot-secret"}'::JSONB,
    '{}'::JSONB,
    2,
    0,
    FALSE,
    500,
    500
)
