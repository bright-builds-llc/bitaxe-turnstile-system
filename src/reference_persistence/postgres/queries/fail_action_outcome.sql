UPDATE relying_service.protected_action_outcomes
SET status = 'failed', safe_reason = $2
WHERE redemption_id = $1 AND status = 'pending'
