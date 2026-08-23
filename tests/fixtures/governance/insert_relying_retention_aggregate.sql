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
    'action_reference_retention',
    'claimant_retention',
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
    'redemption_retention',
    'https://relying.example',
    'action_reference_retention',
    'claimant_retention',
    'account_creation',
    'account-creation.standard.v1',
    100,
    200,
    3,
    3024100
);

INSERT INTO relying_service.pass_consumptions (
    issuer,
    pass_id,
    redemption_id,
    consumed_at_unix_seconds,
    gate_pass_expires_at_unix_seconds
)
VALUES (
    'https://authority.example',
    'pass_retention',
    'redemption_retention',
    100,
    200
);

INSERT INTO relying_service.protected_action_outcomes (
    redemption_id,
    status,
    safe_result,
    terminal_at_unix_seconds
)
VALUES (
    'redemption_retention',
    'succeeded',
    '{"account_id":"account_retained"}'::JSONB,
    100
);

INSERT INTO relying_service.action_execution_intents (
    redemption_id,
    status,
    attempt_count,
    next_attempt_at_unix_seconds
)
VALUES ('redemption_retention', 'completed', 1, 100);

INSERT INTO relying_service.action_execution_attempts (
    attempt_id,
    redemption_id,
    attempt_number,
    status,
    started_at_unix_seconds,
    completed_at_unix_seconds
)
VALUES (
    'attempt_retention',
    'redemption_retention',
    1,
    'succeeded',
    100,
    100
);

INSERT INTO relying_service.reference_accounts (account_id, action_reference)
VALUES ('account_retained', 'action_reference_retention');
