UPDATE relying_service.action_execution_intents
SET
    status = 'pending',
    lease_owner = NULL,
    lease_expires_at_unix_seconds = NULL,
    next_attempt_at_unix_seconds = $3
WHERE
    redemption_id = $1
    AND status = 'processing'
    AND lease_owner = $2
    AND lease_expires_at_unix_seconds > EXTRACT(EPOCH FROM clock_timestamp())::bigint
