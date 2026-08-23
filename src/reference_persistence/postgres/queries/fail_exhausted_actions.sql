WITH failed AS (
    UPDATE relying_service.action_execution_intents AS intent
    SET
        status = 'failed',
        lease_owner = NULL,
        lease_expires_at_unix_seconds = NULL
    FROM relying_service.redemption_records AS record
    WHERE
        record.redemption_id = intent.redemption_id
        AND intent.status IN ('pending', 'processing')
        AND (
            record.execution_deadline_unix_seconds <= $1
            OR (
                intent.attempt_count >= record.maximum_attempts
                AND (
                    intent.status = 'pending'
                    OR intent.lease_expires_at_unix_seconds <= $1
                )
            )
        )
    RETURNING intent.redemption_id
)
UPDATE relying_service.protected_action_outcomes AS outcome
SET status = 'failed',
    safe_reason = 'action_execution_exhausted',
    terminal_at_unix_seconds = $1
FROM failed
WHERE outcome.redemption_id = failed.redemption_id AND outcome.status = 'pending'
