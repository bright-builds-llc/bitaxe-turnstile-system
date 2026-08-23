INSERT INTO gate_authority.gate_pass_issuance_intents (
    challenge_id,
    pass_id,
    algorithm,
    claims_template,
    signing_deadline_unix_seconds,
    status,
    authority_kid,
    gate_pass,
    issued_at_unix_seconds,
    expires_at_unix_seconds,
    gate_pass_retired_at_unix_seconds
)
VALUES (
    'challenge_authority_retention',
    'pass_early_retirement',
    'EdDSA',
    '{}'::JSONB,
    100,
    'issued',
    'authority-key',
    NULL,
    100,
    200,
    199
)
