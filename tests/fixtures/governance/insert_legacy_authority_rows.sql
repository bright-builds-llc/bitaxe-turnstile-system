INSERT INTO gate_authority.work_challenges (
    challenge_id,
    descriptor,
    gate_pass_claims_seed,
    work_requirement,
    verified_progress,
    satisfied,
    expires_at_unix_seconds
)
VALUES (
    'challenge_legacy_backfill',
    '{}'::JSONB,
    '{}'::JSONB,
    1,
    1,
    TRUE,
    100
);

INSERT INTO gate_authority.gate_pass_issuance_intents (
    challenge_id,
    pass_id,
    algorithm,
    claims_template,
    signing_deadline_unix_seconds,
    status
)
VALUES (
    'challenge_legacy_backfill',
    'pass_legacy_backfill',
    'EdDSA',
    '{}'::JSONB,
    100,
    'failed'
);
