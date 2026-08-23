INSERT INTO relying_service.action_execution_intents (
    redemption_id,
    status,
    next_attempt_at_unix_seconds
)
VALUES ($1, 'pending', $2)
