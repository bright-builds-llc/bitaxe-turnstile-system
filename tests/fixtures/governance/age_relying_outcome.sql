UPDATE relying_service.protected_action_outcomes
SET terminal_at_unix_seconds = $2
WHERE redemption_id = $1 AND status = 'succeeded'
