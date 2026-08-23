UPDATE relying_service.action_execution_intents
SET
    status = 'processing',
    attempt_count = $2,
    lease_owner = $3,
    lease_expires_at_unix_seconds = $4
WHERE redemption_id = $1
