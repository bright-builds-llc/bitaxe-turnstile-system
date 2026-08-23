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
    'challenge_authority_retention',
    '{}'::JSONB,
    '{}'::JSONB,
    1,
    1,
    TRUE,
    100,
    100
)
