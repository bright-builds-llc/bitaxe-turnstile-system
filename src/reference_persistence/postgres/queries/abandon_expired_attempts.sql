UPDATE relying_service.action_execution_attempts AS attempt
SET status = 'abandoned', completed_at_unix_seconds = $1
FROM relying_service.action_execution_intents AS intent
WHERE
    attempt.redemption_id = intent.redemption_id
    AND attempt.attempt_number = intent.attempt_count
    AND attempt.status = 'processing'
    AND intent.status = 'processing'
    AND intent.lease_expires_at_unix_seconds <= $1
