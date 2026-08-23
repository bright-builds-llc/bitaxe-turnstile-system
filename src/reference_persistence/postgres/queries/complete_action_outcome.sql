UPDATE relying_service.protected_action_outcomes
SET status = 'succeeded',
    safe_result = $2,
    terminal_at_unix_seconds = $3
WHERE redemption_id = $1 AND status = 'pending'
