SELECT
    claimant_jkt,
    protected_action_type,
    action_policy,
    execution_timeout_seconds,
    maximum_attempts
FROM relying_service.protected_actions
WHERE audience = $1 AND action_reference = $2
FOR UPDATE
