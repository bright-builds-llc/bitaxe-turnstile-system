UPDATE relying_service.protected_action_outcomes
SET status = 'succeeded', safe_result = $2
WHERE redemption_id = $1 AND status = 'pending'
