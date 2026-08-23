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
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
