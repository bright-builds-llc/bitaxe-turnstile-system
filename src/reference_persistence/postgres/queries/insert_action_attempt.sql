INSERT INTO relying_service.action_execution_attempts (
    attempt_id,
    redemption_id,
    attempt_number,
    status,
    started_at_unix_seconds
)
VALUES ($1, $2, $3, 'processing', $4)
