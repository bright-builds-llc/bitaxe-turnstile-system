UPDATE relying_service.action_execution_intents AS intent
SET
    status = 'completed',
    lease_owner = NULL,
    lease_expires_at_unix_seconds = NULL
FROM relying_service.redemption_records AS record
WHERE
    intent.redemption_id = $1
    AND record.redemption_id = intent.redemption_id
    AND intent.status = 'processing'
    AND intent.lease_owner = $2
    AND intent.lease_expires_at_unix_seconds > EXTRACT(EPOCH FROM clock_timestamp())::bigint
    AND record.execution_deadline_unix_seconds > EXTRACT(EPOCH FROM clock_timestamp())::bigint
