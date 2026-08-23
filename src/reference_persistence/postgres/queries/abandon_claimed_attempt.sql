UPDATE relying_service.action_execution_attempts
SET status = 'abandoned', completed_at_unix_seconds = $3
WHERE redemption_id = $1 AND attempt_number = $2 AND status = 'processing'
