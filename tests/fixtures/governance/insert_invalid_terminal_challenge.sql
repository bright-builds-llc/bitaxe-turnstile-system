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
    'challenge_invalid_terminal',
    '{}'::JSONB,
    '{}'::JSONB,
    1,
    0,
    FALSE,
    100,
    0
)
