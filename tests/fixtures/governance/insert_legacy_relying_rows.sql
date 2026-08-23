INSERT INTO relying_service.protected_actions (
    audience,
    action_reference,
    claimant_jkt,
    protected_action_type,
    action_policy,
    execution_timeout_seconds,
    maximum_attempts,
    retryable_error_classes,
    created_at_unix_seconds
)
VALUES (
    'https://relying.example',
    'action_legacy_retention',
    'claimant_legacy_retention',
    'account_creation',
    'account-creation.standard.v1',
    300,
    3,
    '["transient"]'::JSONB,
    50
);

INSERT INTO relying_service.redemption_records (
    redemption_id,
    audience,
    action_reference,
    claimant_jkt,
    protected_action_type,
    action_policy,
    accepted_at_unix_seconds,
    execution_deadline_unix_seconds,
    maximum_attempts,
    public_lookup_expires_at_unix_seconds
)
VALUES (
    'redemption_legacy_retention',
    'https://relying.example',
    'action_legacy_retention',
    'claimant_legacy_retention',
    'account_creation',
    'account-creation.standard.v1',
    100,
    200,
    3,
    100
);

INSERT INTO relying_service.pass_consumptions (
    issuer,
    pass_id,
    redemption_id,
    consumed_at_unix_seconds
)
VALUES (
    'https://authority.example',
    'pass_legacy_retention',
    'redemption_legacy_retention',
    100
);

INSERT INTO relying_service.protected_action_outcomes (
    redemption_id,
    status,
    safe_result
)
VALUES (
    'redemption_legacy_retention',
    'succeeded',
    '{"account_id":"account_legacy_retained"}'::JSONB
);

INSERT INTO relying_service.action_execution_intents (
    redemption_id,
    status,
    attempt_count,
    next_attempt_at_unix_seconds
)
VALUES ('redemption_legacy_retention', 'completed', 1, 100);

INSERT INTO relying_service.action_execution_attempts (
    attempt_id,
    redemption_id,
    attempt_number,
    status,
    started_at_unix_seconds,
    completed_at_unix_seconds
)
VALUES (
    'attempt_legacy_retention',
    'redemption_legacy_retention',
    1,
    'succeeded',
    100,
    100
);
