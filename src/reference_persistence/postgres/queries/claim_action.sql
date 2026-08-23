SELECT
    intent.redemption_id,
    intent.attempt_count,
    record.action_reference,
    action.retryable_error_classes
FROM relying_service.action_execution_intents AS intent
JOIN relying_service.redemption_records AS record
    ON record.redemption_id = intent.redemption_id
JOIN relying_service.protected_actions AS action
    ON action.audience = record.audience
    AND action.action_reference = record.action_reference
WHERE
    record.execution_deadline_unix_seconds > $1
    AND intent.attempt_count < record.maximum_attempts
    AND intent.next_attempt_at_unix_seconds <= $1
    AND (
        intent.status = 'pending'
        OR (
            intent.status = 'processing'
            AND intent.lease_expires_at_unix_seconds <= $1
        )
    )
ORDER BY intent.next_attempt_at_unix_seconds, intent.redemption_id
FOR UPDATE OF intent SKIP LOCKED
LIMIT 1
